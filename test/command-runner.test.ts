import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { runHostCmd } from '../src/command-runner.js';
import { withTempDir } from './utils/tmpdir.js';

function captureConsole() {
  const outChunks: string[] = [];
  const errChunks: string[] = [];

  const out = new Writable({
    write(chunk, _enc, cb) {
      outChunks.push(
        typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      );
      cb();
    },
  });

  const err = new Writable({
    write(chunk, _enc, cb) {
      errChunks.push(
        typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      );
      cb();
    },
  });

  const logger = new Console(out, err) as unknown as {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };

  const stdout = () => outChunks.join('');
  const stderr = () => errChunks.join('');

  return { logger, stdout, stderr };
}

const q = (s: string) => JSON.stringify(s);

describe('runHostCmd (no mocks, full-stream asserts)', () => {
  it(
    'success: returns trimmed stdout and logs it',
    withTempDir((cwd) => {
      const { logger, stdout, stderr } = captureConsole();

      const code = 'console.log("hello"); console.log("");';
      const cmd = `${process.execPath} -e ${q(code)}`;

      const result = runHostCmd(cmd, cwd, logger);

      expect(result).toBe('hello');
      expect(stdout()).toBe(`$ ${cmd}\nhello\n`);
      expect(stderr()).toBe('');
    }),
  );

  it(
    'success with no output: logs "(no output)" and returns empty string',
    withTempDir((cwd) => {
      const { logger, stdout, stderr } = captureConsole();

      const cmd = `${process.execPath} -e ${q('')}`;

      const result = runHostCmd(cmd, cwd, logger);

      expect(result).toBe('');
      expect(stdout()).toBe(`$ ${cmd}\n(no output)\n`);
      expect(stderr()).toBe('');
    }),
  );

  it(
    'failure: logs command, stdout, stderr, and rethrows',
    withTempDir((cwd) => {
      const { logger, stdout, stderr } = captureConsole();

      const code =
        'process.stdout.write("out\\n");' +
        'process.stderr.write("err\\n");' +
        'process.exit(7);';
      const cmd = `${process.execPath} -e ${q(code)}`;

      let threw = false;
      try {
        runHostCmd(cmd, cwd, logger);
      } catch {
        threw = true;
      }

      expect(threw).toBe(true);
      expect(stdout()).toBe(`$ ${cmd}\n`);

      const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `^` +
          `Command failed: ${escape(cmd)}\\n` +
          `out\\n` +
          `err\\n` +
          `[\\s\\S]+` + // platform-specific execSync error message
          `$`,
      );
      expect(stderr()).toMatch(pattern);
    }),
  );
});
