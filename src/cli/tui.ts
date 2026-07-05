/**
 * Claude Code-inspired TUI for nclaw CLI.
 *
 * Key design decisions:
 * - We do NOT use readline's `output: process.stdout` because readline
 *   interleaves its own line-refresh logic with any other stdout writes
 *   (tool output, streaming chunks, confirm-gate prompts).
 * - Instead we run stdin in raw mode, manage the cursor ourselves, and draw
 *   a single persistent input line at the bottom of the terminal with a
 *   scrollback area above it.
 * - A `GateIO` interface is exposed so confirm-gate.ts can prompt for
 *   approvals without fighting the chat UI.
 *
 * Visual layout (Claude Code style):
 *    You
 *    user message here
 *
 *    Alfred
 *    streamed assistant content appears here...
 *
 *    ✓ fs_write  src/file.ts
 *      42 bytes written
 */

import { EventEmitter } from 'events';

// ── ANSI helpers ────────────────────────────────────────────────────────────

const ESC = '\x1b[';

const ansi = {
  clearScreen:     ESC + '2J',
  cursorHome:      ESC + 'H',
  cursorShow:      ESC + '?25h',
  cursorHide:      ESC + '?25l',
  cursorUp:        (n = 1) => ESC + `${n}A`,
  cursorDown:      (n = 1) => ESC + `${n}B`,
  cursorLeft:      (n = 1) => ESC + `${n}D`,
  cursorRight:     (n = 1) => ESC + `${n}C`,
  eraseLine:       ESC + '2K',
  eraseLineEnd:    ESC + '0K',
  eraseLineStart:  ESC + '1K',
  saveCursor:      ESC + 's',
  restoreCursor:   ESC + 'u',
  goto:            (row: number, col: number) => ESC + `${row};${col}H`,
  dim:             '\x1b[2m',
  bold:            '\x1b[1m',
  cyan:            '\x1b[36m',
  green:           '\x1b[32m',
  yellow:          '\x1b[33m',
  red:             '\x1b[31m',
  reset:           '\x1b[0m',
  gray:            '\x1b[90m',
  white:           '\x1b[37m',
  brightCyan:      '\x1b[96m',
  bgCyan:          '\x1b[46m',
};

// ── Types ───────────────────────────────────────────────────────────────────

export type Status = 'idle' | 'thinking' | 'tool' | 'error';

export interface GateIO {
  askYesNo(question: string): Promise<boolean>;
  askInput(question: string): Promise<string>;
  writeLine(text: string): void;
}

// ── Terminal TUI ────────────────────────────────────────────────────────────

export class Tui {
  private inputBuffer = '';
  private cursorPos = 0;
  private promptStr = '';
  private isRaw = false;
  private history: string[] = [];
  private maxHistory = 500;
  private historyIndex = -1;
  private status: Status = 'idle';
  private statusText = '';
  private shutdown = false;
  private emitter = new EventEmitter();

  // Stream state machine
  private streamMode: 'none' | 'response' = 'none';
  private hadRealContent = false;

  // Spinner
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerIdx = 0;
  private readonly spinnerFrames = ['\u25cc', '\u25d0', '\u25d1', '\u25d2', '\u25d3'];

  constructor(
    private stdin: NodeJS.ReadStream = process.stdin,
    private stdout: NodeJS.WriteStream = process.stdout,
  ) {}

  /** Start raw-mode input loop. */
  start(prompt = '›'): void {
    this.promptStr = prompt;
    if (!this.stdin.isTTY) {
      this.stdin.on('data', (data: Buffer) => {
        const lines = data.toString('utf8').split(/\r?\n/);
        for (const line of lines) {
          if (line.trim()) this.emitter.emit('submit', line.trim());
        }
      });
      return;
    }

    this.isRaw = true;
    this.stdin.setRawMode(true);
    this.stdin.setEncoding('utf8');
    this.stdin.resume();

    this.stdout.write(ansi.cursorShow);
    this.drawInputLine();

    this.stdin.on('data', (key: string) => this.handleKey(key));
  }

  onSubmit(handler: (line: string) => void): void {
    this.emitter.on('submit', handler);
  }

  onClose(handler: () => void): void {
    this.emitter.on('close', handler);
  }

  // ── Conversation blocks (Claude Code style) ───────────────────────────

  /** Echo the user's message as a distinct "You" block. */
  echoUserMessage(message: string): void {
    if (this.streamMode !== 'none') this._closeStream();
    this.writeOutput(`${ansi.bold}${ansi.cyan}You${ansi.reset}`);
    this.writeOutput(message);
  }

  /**
   * Start streaming an assistant response.
   * Prints the agent name as a header, then a temporary thinking spinner
   * below it.  As soon as real tokens arrive the spinner is erased and
   * content takes its place.
   */
  beginAssistantStream(agentName: string, agentColor = ansi.green): void {
    if (this.streamMode !== 'none') this._closeStream();
    this.streamMode = 'response';
    this.hadRealContent = false;

    // Erase the bottom prompt and draw the agent name as a header.
    this.stdout.write(ansi.eraseLine + ansi.cursorLeft(999));
    this.stdout.write(`${ansi.bold}${agentColor}${agentName}${ansi.reset}\n`);

    // Reserve a working line that will become the first line of content
    // or temporarily show a spinner.
    this._showWorkingLine();
    this._startSpinner();
  }

  /** Append a raw text chunk to the current assistant stream. */
  writeStreamChunk(chunk: string): void {
    // Replace the working-line spinner with real content as soon
    // as tokens arrive.
    if (!this.hadRealContent) {
      this._stopSpinner();
      this._clearWorkingLine();
      this.hadRealContent = true;
    }

    if (chunk.includes('\n')) {
      const parts = chunk.split('\n');
      for (let i = 0; i < parts.length; i++) {
        this.stdout.write(parts[i]);
        if (i < parts.length - 1) this.stdout.write('\n');
      }
    } else {
      this.stdout.write(chunk);
    }
  }

  /** Finalise the current assistant stream. */
  endAssistantStream(): void {
    if (this.streamMode !== 'response') return;
    this._stopSpinner();
    // If we never received any real tokens, erase the working spinner
    if (!this.hadRealContent) {
      this._clearWorkingLine();
    }
    this._closeStream();
  }

  /**
   * Print a tool-call / execution block.
   * If called while streaming, finalises current stream first.
   */
  writeToolBlock(
    title: string,
    body: string,
    status: 'pending' | 'running' | 'done' | 'error' = 'done',
  ): void {
    if (this.streamMode !== 'none') this._closeStream();

    const icon =
      status === 'done'
        ? `${ansi.green}\u2713${ansi.reset}`
        : status === 'error'
          ? `${ansi.red}\u2717${ansi.reset}`
          : status === 'running'
            ? `${ansi.yellow}\u25b6${ansi.reset}`
            : `${ansi.gray}\u25cb${ansi.reset}`;

    this.writeOutput(`${icon} ${ansi.bold}${title}${ansi.reset}`, { color: ansi.gray });
    const lines = body.split('\n');
    for (const line of lines) {
      if (line.trim()) {
        this.writeOutput(`  ${line}`, { color: ansi.gray });
      } else {
        this.writeOutput('', { color: ansi.gray });
      }
    }
  }

  /** Print a "thinking / plan" block (grey dot-leader list). */
  writeThinkingBlock(lines: string[]): void {
    if (this.streamMode !== 'none') this._closeStream();
    for (const line of lines) {
      this.writeOutput(`  ${ansi.dim}\u00b7 ${line}${ansi.reset}`);
    }
  }

  // ── Legacy / generic output ─────────────────────────────────────────────

  /** Write text above the input area. Safe to call while streaming. */
  writeOutput(text: string, opts?: { color?: string; prefix?: string }): void {
    if (!this.isRaw) {
      if (opts?.prefix) this.stdout.write(opts.prefix);
      if (opts?.color) this.stdout.write(opts.color);
      this.stdout.write(text);
      if (opts?.color) this.stdout.write(ansi.reset);
      this.stdout.write('\n');
      return;
    }

    const wasStreaming = this.streamMode !== 'none';
    if (wasStreaming) this._closeStream();

    this.stdout.write(ansi.eraseLine + ansi.cursorLeft(999));
    const lines = text.split('\n');
    for (const line of lines) {
      if (opts?.prefix) this.stdout.write(opts.prefix);
      if (opts?.color) this.stdout.write(opts.color);
      this.stdout.write(line);
      if (opts?.color) this.stdout.write(ansi.reset);
      this.stdout.write('\n');
    }
    this.drawInputLine();
  }

  /** Raw chunk append (no newline). Prefer writeStreamChunk. */
  writeChunk(chunk: string, opts?: { color?: string; prefix?: string }): void {
    if (!this.isRaw) {
      if (opts?.prefix) this.stdout.write(opts.prefix);
      if (opts?.color) this.stdout.write(opts.color);
      this.stdout.write(chunk);
      if (opts?.color) this.stdout.write(ansi.reset);
      return;
    }
    if (opts?.prefix) this.stdout.write(opts.prefix);
    if (opts?.color) this.stdout.write(opts.color);
    this.stdout.write(chunk);
    if (opts?.color) this.stdout.write(ansi.reset);
  }

  /** Call after streaming finishes with raw chunks. Prefer endAssistantStream. */
  finalizeChunkBlock(): void {
    if (this.isRaw) {
      this.stdout.write('\n');
      this.drawInputLine();
    } else {
      this.stdout.write('\n');
    }
  }

  /** Styled block. Prefer writeToolBlock / writeThinkingBlock. */
  writeBlock(label: string, body: string, color = ansi.gray): void {
    this.writeOutput('', { color });
    this.writeOutput(`${ansi.bold}${label}${ansi.reset}`, { color });
    const lines = body.split('\n');
    for (const line of lines) {
      this.writeOutput(`  ${line}`, { color });
    }
    if (body) this.writeOutput('', { color });
  }

  setStatus(status: Status, text?: string): void {
    this.status = status;
    this.statusText = text ?? '';
    if (this.isRaw) this.drawInputLine();
  }

  /** Create a GateIO abstraction for confirm-gate.ts. */
  createGateIO(): GateIO {
    return {
      askYesNo: async (question) => this.promptYesNo(question),
      askInput: async (question) => this.promptInput(question),
      writeLine: (text) => this.writeOutput(text),
    };
  }

  /** Restore terminal and fire close event. */
  stop(): void {
    if (this.shutdown) return;
    this.shutdown = true;
    this._stopSpinner();
    if (this.isRaw) {
      this.stdin.setRawMode(false);
      this.stdout.write(ansi.cursorShow + '\n');
    }
    this.emitter.emit('close');
  }

  // ── Internal streaming helpers ────────────────────────────────────────────

  /** Show a dim "working…" line below the agent name before tokens arrive. */
  private _showWorkingLine(): void {
    this.stdout.write(
      `${ansi.dim}\u25cc working\u2026${ansi.reset}`,
    );
  }

  /** Erase the working-line spinner so content can be written in its place. */
  private _clearWorkingLine(): void {
    this.stdout.write(ansi.eraseLine + ansi.cursorLeft(999));
  }

  private _startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      if (this.streamMode !== 'response' || !this.spinnerTimer) return;
      this.spinnerIdx = (this.spinnerIdx + 1) % this.spinnerFrames.length;
      // Cursor is at the end of the working line – go to start and rewrite.
      this.stdout.write(ansi.cursorLeft(999));
      this.stdout.write(
        `${ansi.dim}${this.spinnerFrames[this.spinnerIdx]} working\u2026${ansi.reset}`,
      );
    }, 120);
  }

  private _stopSpinner(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  /** Close whatever stream is active, then redraw the prompt. */
  private _closeStream(): void {
    this._stopSpinner();
    if (this.streamMode === 'none') return;
    this.streamMode = 'none';
    this.hadRealContent = false;
    this.stdout.write('\n');
    this.drawInputLine();
  }

  // ── Input line rendering ──────────────────────────────────────────────────

  private drawInputLine(): void {
    const statusIcon = this.statusIcon();
    const statusExtra = this.statusText
      ? ` ${ansi.dim}${this.statusText}${ansi.reset}`
      : '';
    const line = `${ansi.dim}${this.promptStr}${ansi.reset} ${this.inputBuffer}`;
    this.stdout.write(ansi.eraseLine + ansi.cursorLeft(999));
    this.stdout.write(`${statusIcon}${statusExtra} ${line}`);
    const tail = this.inputBuffer.length - this.cursorPos;
    if (tail > 0) this.stdout.write(ansi.cursorLeft(tail));
  }

  private redrawInput(): void {
    this.drawInputLine();
  }

  private statusIcon(): string {
    switch (this.status) {
      case 'thinking': return `${ansi.yellow}\u25cb${ansi.reset}`;
      case 'tool':     return `${ansi.cyan}\u25cf${ansi.reset}`;
      case 'error':    return `${ansi.red}\u2717${ansi.reset}`;
      default:         return `${ansi.dim}\u25cf${ansi.reset}`;
    }
  }

  // ── Key handling ──────────────────────────────────────────────────────────

  private handleKey(key: string): void {
    if (key === '\u0003') {
      // Ctrl+C
      this.writeOutput('\n  Goodbye.', { color: ansi.dim });
      this.stop();
      process.exit(0);
    }
    if (key === '\u0004') {
      // Ctrl+D
      if (this.inputBuffer.length === 0) {
        this.writeOutput('\n  Goodbye.', { color: ansi.dim });
        this.stop();
        process.exit(0);
      }
    }
    if (key === '\r' || key === '\n') {
      const line = this.inputBuffer.trim();
      this.inputBuffer = '';
      this.cursorPos = 0;
      this.historyIndex = -1;
      if (line) {
        this.history.push(line);
        if (this.history.length > this.maxHistory) this.history.shift();
        this.emitter.emit('submit', line);
      }
      this.stdout.write('\n');
      this.drawInputLine();
      return;
    }
    if (key === '\u007f' || key === '\b') {
      // Backspace
      if (this.cursorPos > 0) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos - 1) +
          this.inputBuffer.slice(this.cursorPos);
        this.cursorPos--;
        this.redrawInput();
      }
      return;
    }
    if (key === '\u001b[C') {
      // Right
      if (this.cursorPos < this.inputBuffer.length) {
        this.cursorPos++;
        this.stdout.write(ansi.cursorRight(1));
      }
      return;
    }
    if (key === '\u001b[D') {
      // Left
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.stdout.write(ansi.cursorLeft(1));
      }
      return;
    }
    if (key === '\u001b[3~') {
      // Delete
      if (this.cursorPos < this.inputBuffer.length) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.cursorPos) +
          this.inputBuffer.slice(this.cursorPos + 1);
        this.redrawInput();
      }
      return;
    }
    if (key === '\u001b[H') {
      // Home
      this.cursorPos = 0;
      this.redrawInput();
      return;
    }
    if (key === '\u001b[F') {
      // End
      this.cursorPos = this.inputBuffer.length;
      this.redrawInput();
      return;
    }
    if (key === '\u001b[A') {
      // Up → previous history
      if (this.history.length === 0) return;
      if (this.historyIndex < this.history.length - 1) {
        this.historyIndex++;
      } else {
        return;
      }
      this.inputBuffer = this.history[this.history.length - 1 - this.historyIndex];
      this.cursorPos = this.inputBuffer.length;
      this.redrawInput();
      return;
    }
    if (key === '\u001b[B') {
      // Down → next history
      if (this.history.length === 0) return;
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.inputBuffer = this.history[this.history.length - 1 - this.historyIndex];
        this.cursorPos = this.inputBuffer.length;
        this.redrawInput();
      } else if (this.historyIndex === 0) {
        this.historyIndex = -1;
        this.inputBuffer = '';
        this.cursorPos = 0;
        this.redrawInput();
      }
      return;
    }
    if (key.startsWith('\u001b')) {
      // Ignore unhandled escape sequences
      return;
    }
    if (key.charCodeAt(0) >= 32) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.cursorPos) +
        key +
        this.inputBuffer.slice(this.cursorPos);
      this.cursorPos += key.length;
      this.redrawInput();
    }
  }

  // ── Gate prompts ──────────────────────────────────────────────────────────

  private async promptYesNo(question: string): Promise<boolean> {
    if (!this.isRaw) {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: this.stdin,
        output: this.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(question, (ans) => {
          rl.close();
          resolve(ans);
        });
      });
      return answer.trim().toLowerCase() === 'y';
    }

    this.stdout.write(ansi.eraseLine + ansi.cursorLeft(999));
    this.stdout.write(question);
    return new Promise((resolve) => {
      let buf = '';
      const handler = (key: string) => {
        if (key === '\r' || key === '\n') {
          this.stdin.removeListener('data', handler);
          const ok = buf.trim().toLowerCase() === 'y';
          this.stdout.write('\n');
          this.drawInputLine();
          resolve(ok);
          return;
        }
        if (key === '\u0003') {
          this.stdin.removeListener('data', handler);
          this.stop();
          process.exit(0);
        }
        if (key === '\u007f' || key === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            this.stdout.write(ansi.cursorLeft(1) + ' ' + ansi.cursorLeft(1));
          }
          return;
        }
        if (key.length === 1 && key.charCodeAt(0) >= 32) {
          buf += key;
          this.stdout.write(key);
        }
      };
      this.stdin.on('data', handler);
    });
  }

  private async promptInput(question: string): Promise<string> {
    if (!this.isRaw) {
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: this.stdin,
        output: this.stdout,
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question(question, (ans) => {
          rl.close();
          resolve(ans);
        });
      });
      return answer;
    }

    this.stdout.write(ansi.eraseLine + ansi.cursorLeft(999));
    this.stdout.write(question);
    return new Promise((resolve) => {
      let buf = '';
      let pos = 0;
      const handler = (key: string) => {
        if (key === '\r' || key === '\n') {
          this.stdin.removeListener('data', handler);
          this.stdout.write('\n');
          this.drawInputLine();
          resolve(buf);
          return;
        }
        if (key === '\u0003') {
          this.stdin.removeListener('data', handler);
          this.stop();
          process.exit(0);
        }
        if (key === '\u007f' || key === '\b') {
          if (pos > 0) {
            buf = buf.slice(0, pos - 1) + buf.slice(pos);
            pos--;
            this.stdout.write(ansi.cursorLeft(1) + ' ' + ansi.cursorLeft(1));
          }
          return;
        }
        if (key === '\u001b[D') {
          if (pos > 0) {
            pos--;
            this.stdout.write(ansi.cursorLeft(1));
          }
          return;
        }
        if (key === '\u001b[C') {
          if (pos < buf.length) {
            pos++;
            this.stdout.write(ansi.cursorRight(1));
          }
          return;
        }
        if (key.length === 1 && key.charCodeAt(0) >= 32) {
          buf = buf.slice(0, pos) + key + buf.slice(pos);
          pos += key.length;
          this.stdout.write(key);
        }
      };
      this.stdin.on('data', handler);
    });
  }
}

// ── Global crash handlers ───────────────────────────────────────────────────

export function installGlobalHandlers(logger: { error: (msg: string, data?: unknown) => void }): void {
  process.on('uncaughtException', (err) => {
    try {
      logger.error('Uncaught exception', { message: err.message, stack: err.stack });
      process.stderr.write(`\n${ansi.red}Fatal error:${ansi.reset} ${err.message}\n`);
      if (err.stack) process.stderr.write(err.stack + '\n');
    } catch {
      process.stderr.write(`Fatal: ${err.message}\n`);
    }
    setTimeout(() => process.exit(1), 250);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('Unhandled rejection', { message: msg, stack });
    process.stderr.write(`\n${ansi.red}Unhandled rejection:${ansi.reset} ${msg}\n`);
    if (stack) process.stderr.write(stack + '\n');
    setTimeout(() => process.exit(1), 250);
  });

  process.on('SIGINT', () => {
    process.stdout.write('\n');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    process.stdout.write('\n');
    process.exit(0);
  });
}
