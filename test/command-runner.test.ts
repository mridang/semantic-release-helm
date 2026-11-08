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

describe('runHostCmd failure output that is only whitespace', () => {
  it(
    'logs whitespace-only stderr as captured',
    withTempDir((cwd) => {
      const { logger, stderr } = captureConsole();
      const code = 'process.stderr.write("  \\n"); process.exit(3);';
      const cmd = `${process.execPath} -e ${q(code)}`;

      expect(() => runHostCmd(cmd, cwd, logger)).toThrow();
      expect(stderr()).toContain('Command failed:');
      expect(stderr()).toContain('  \n');
    }),
  );

  it(
    'logs nothing extra for empty stdout and stderr',
    withTempDir((cwd) => {
      const { logger, stderr } = captureConsole();
      const cmd = `${process.execPath} -e ${q('process.exit(4);')}`;

      expect(() => runHostCmd(cmd, cwd, logger)).toThrow();
      expect(stderr().startsWith(`Command failed: ${cmd}\n`)).toBe(true);
      expect(stderr().split('\n')[1]).toMatch(/^Command failed/);
    }),
  );
});

describe('runHostCmd credential redaction', () => {
  const url = 'https://x-access-token:SECRET@github.com/o/r.git';

  it(
    'logs no line that contains a credential from stdout, stderr, the command or the message',
    withTempDir((cwd) => {
      const { logger, stdout, stderr } = captureConsole();
      const ok = `${process.execPath} -e ${q(`console.log(${q(url)})`)}`;
      expect(runHostCmd(ok, cwd, logger)).toBe(url);

      const fail = `${process.execPath} -e ${q(
        `console.error(${q(url)}); console.log(${q(url)}); process.exit(2); // ${url}`,
      )}`;
      expect(() => runHostCmd(fail, cwd, logger)).toThrow();

      const logged = stdout() + stderr();
      expect(logged).not.toContain('SECRET');
      expect(logged).toContain('https://***@github.com/o/r.git');
    }),
  );

  it(
    'leaves URLs without credentials untouched',
    withTempDir((cwd) => {
      const { logger, stdout } = captureConsole();
      const cmd = `${process.execPath} -e ${q('console.log("https://github.com/o/r.git")')}`;
      runHostCmd(cmd, cwd, logger);
      expect(stdout()).toContain('\nhttps://github.com/o/r.git\n');
    }),
  );
});

describe('runHostCmd rethrown error', () => {
  it(
    'carries no credential in its message, stdout or stderr',
    withTempDir((cwd) => {
      const { logger } = captureConsole();
      const u = 'https://u:p@ss@host/x';
      const cmd = `${process.execPath} -e ${q(`console.log(${q(u)}); console.error(${q(u)}); process.exit(3)`)}`;
      const failure = (() => {
        try {
          runHostCmd(cmd, cwd, logger);
          return undefined;
        } catch (e) {
          return e;
        }
      })();
      expect(failure).toMatchObject({ status: 3 });
      const text = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
      expect(text).not.toContain('ss@host');
      expect(text).toContain('https://***@host/x');
    }),
  );
});
