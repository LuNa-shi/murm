import { StringDecoder } from 'node:string_decoder';
import { StdinBuffer, stripTerminalSequences, type Terminal } from '@earendil-works/pi-tui';

const beginPaste = '\x1b[200~';
const endPaste = '\x1b[201~';
const maxPasteBytes = 262_144;

export function terminalText(value: string) {
  return stripTerminalSequences(value).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

export class MurmTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  private readonly input = process.stdin;
  private readonly stdout = process.stdout;
  private readonly transport = this.stdout.write.bind(this.stdout);
  private readonly decoder = new StringDecoder('utf8');
  private readonly keys = new StdinBuffer();
  private resize?: () => void;
  private inputCallback?: (data: string) => void;
  private raw?: boolean;
  private paused = true;
  private partial = '';
  private partialTimer?: ReturnType<typeof setTimeout>;

  enableRawMode() {
    if (this.raw !== undefined) return;
    const previous = this.input.isRaw;
    this.paused = this.input.isPaused();
    this.input.setRawMode(true);
    this.raw = previous;
  }

  get enabled() { return this.raw !== undefined; }
  private paste?: string[];
  private pasteBytes = 0;
  private surrogate = '';

  constructor(private readonly pasteRejected: () => void) {
    this.keys.on('data', key => {
      if (/^[\uD800-\uDBFF]$/.test(key)) {
        this.surrogate = key;
        return;
      }
      if (this.surrogate && /^[\uDC00-\uDFFF]$/.test(key)) key = this.surrogate + key;
      this.surrogate = '';
      this.inputCallback?.(key);
    });
  }

  start(onInput: (data: string) => void, onResize: () => void) {
    this.enableRawMode();
    this.inputCallback = onInput;
    this.resize = onResize;
    this.input.on('data', this.data);
    this.stdout.on('resize', onResize);
    this.write('\x1b[?2004h');
    this.input.resume();
  }

  stop() {
    if (this.raw === undefined) return;
    const previous = this.raw;
    this.raw = undefined;
    this.inputCallback = undefined;
    this.input.off('data', this.data);
    if (this.resize) this.stdout.off('resize', this.resize);
    this.keys.destroy();
    clearTimeout(this.partialTimer);
    try { this.input.setRawMode(previous); }
    finally {
      if (this.paused || this.input.listenerCount('data') === 0) this.input.pause();
      this.write('\x1b[?2004l\x1b[?25h');
    }
  }

  // Keep just the possible delimiter suffix in memory while a paste is open.
  // An oversize paste is discarded through its closing delimiter, including embedded keys.
  private data = (chunk: Buffer | string) => {
    clearTimeout(this.partialTimer);
    let remaining = this.partial + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    this.partial = '';
    while (remaining) {
      const delimiter = this.paste ? endPaste : beginPaste;
      const index = remaining.indexOf(delimiter);
      let end = index;
      if (index < 0) {
        end = remaining.length;
        for (let size = Math.min(delimiter.length - 1, remaining.length); size > 0; size--) {
          if (remaining.endsWith(delimiter.slice(0, size))) {
            this.partial = remaining.slice(-size);
            end -= size;
            break;
          }
        }
      }
      const content = remaining.slice(0, end);
      if (this.paste) {
        this.pasteBytes += Buffer.byteLength(content);
        if (this.pasteBytes <= maxPasteBytes) this.paste.push(content);
        if (index >= 0) {
          const pasted = this.paste;
          this.paste = undefined;
          if (this.pasteBytes > maxPasteBytes) this.pasteRejected();
          else this.inputCallback?.(beginPaste + terminalText(pasted.join('')) + endPaste);
        }
      } else {
        // The key buffer owns lone Escape and ordinary terminal key sequences.
        if (content) this.keys.process(content);
        if (index >= 0) {
          this.paste = [];
          this.pasteBytes = 0;
        }
      }
      remaining = index >= 0 ? remaining.slice(index + delimiter.length) : '';
    }
    if (this.partial && !this.paste) {
      this.partialTimer = setTimeout(() => {
        const pending = this.partial;
        this.partial = '';
        this.keys.process(pending);
      }, 30);
      this.partialTimer.unref();
    }
    if (this.keys.getBuffer().length > 4096) this.keys.clear();
  };

  get columns() { return this.stdout.columns || 80; }
  get rows() { return this.stdout.rows || 24; }
  write(data: string) {
    if (this.stdout.writableLength > 512 * 1024) throw new Error('Terminal output is not draining');
    this.transport(data);
  }
  restoreDisplay() { this.transport('\x1b[?2026l\x1b[?2004l\x1b[?7h\x1b[?1049l\x1b[0m\x1b[?25h'); }
  drained() { return new Promise<void>((resolve, reject) => this.transport('', error => error ? reject(error) : resolve())); }
  async drainInput() {}
  moveBy(lines: number) { if (lines) this.write('\x1b[' + Math.abs(lines) + (lines < 0 ? 'A' : 'B')); }
  hideCursor() { this.write('\x1b[?25l'); }
  showCursor() { this.write('\x1b[?25h'); }
  clearLine() { this.write('\x1b[2K'); }
  clearFromCursor() { this.write('\x1b[J'); }
  clearScreen() { this.write('\x1b[2J\x1b[H'); }
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
