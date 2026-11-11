import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { describe, expect, it } from '@jest/globals';
// noinspection ES6PreferShortImport
import { redactError, runLogged } from '../src/command-runner.js';
import { run } from '../src/utils/exec.js';
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

  const logger = new Console(out, err);

  const stdout = () => outChunks.join('');
  const stderr = () => errChunks.join('');

  return { logger, stdout, stderr };
}

const node = process.execPath;
const q = (s: string) => `'${s}'`;

describe('runLogged (real runner, full-stream asserts)', () => {
  it(
    'success: returns trimmed stdout and logs it',
    withTempDir(async (cwd) => {
      const { logger, stdout, stderr } = captureConsole();
      const code = 'console.log("hello"); console.log("");';

      const result = await runLogged(run, node, ['-e', code], { cwd }, logger);

      expect(result).toBe('hello');
      expect(stdout()).toBe(`$ ${node} -e ${q(code)}\nhello\n`);
      expect(stderr()).toBe('');
    }),
  );

  it(
    'success with no output: logs "(no output)" and returns empty string',
    withTempDir(async (cwd) => {
      const { logger, stdout, stderr } = captureConsole();

      const result = await runLogged(run, node, ['-e', ''], { cwd }, logger);

      expect(result).toBe('');
      expect(stdout()).toBe(`$ ${node} -e ''\n(no output)\n`);
      expect(stderr()).toBe('');
    }),
  );

  it(
    'failure: logs command, stdout, stderr, and rethrows',
    withTempDir(async (cwd) => {
      const { logger, stdout, stderr } = captureConsole();
      const code =
        String.raw`process.stdout.write("out\n");` +
        String.raw`process.stderr.write("err\n");` +
        'process.exit(7);';

      const failure = await runLogged(
        run,
        node,
        ['-e', code],
        { cwd },
        logger,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({ status: 7 });
      expect(stdout()).toBe(`$ ${node} -e ${q(code)}\n`);
      expect(stderr()).toMatch(
        new RegExp(
          String.raw`^Command failed: ${node.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)} -e [\s\S]*\nout\nerr\n[\s\S]+$`,
        ),
      );
    }),
  );
});

describe('runLogged failure output that is only whitespace', () => {
  it(
    'logs whitespace-only stderr as captured',
    withTempDir(async (cwd) => {
      const { logger, stderr } = captureConsole();
      const code = String.raw`process.stderr.write("  \n"); process.exit(3);`;

      await expect(
        runLogged(run, node, ['-e', code], { cwd }, logger),
      ).rejects.toThrow();
      expect(stderr()).toContain('Command failed:');
      expect(stderr()).toContain('  \n');
    }),
  );

  it(
    'logs nothing extra for empty stdout and stderr',
    withTempDir(async (cwd) => {
      const { logger, stderr } = captureConsole();

      await expect(
        runLogged(run, node, ['-e', 'process.exit(4);'], { cwd }, logger),
      ).rejects.toThrow();
      expect(stderr().startsWith('Command failed: ')).toBe(true);
      expect(stderr().split('\n', 2)[1]).toMatch(/^Command failed/);
    }),
  );
});

describe('runLogged credential redaction', () => {
  const url = 'https://x-access-token:SECRET@github.com/o/r.git';

  it(
    'logs no line that contains a credential from stdout, stderr, the command or the message',
    withTempDir(async (cwd) => {
      const { logger, stdout, stderr } = captureConsole();
      expect(
        await runLogged(
          run,
          node,
          ['-e', `console.log(${JSON.stringify(url)})`],
          { cwd },
          logger,
        ),
      ).toBe(url);

      const fail = `console.error(${JSON.stringify(url)}); console.log(${JSON.stringify(url)}); process.exit(2); // ${url}`;
      await expect(
        runLogged(run, node, ['-e', fail], { cwd }, logger),
      ).rejects.toThrow();

      const logged = stdout() + stderr();
      expect(logged).not.toContain('SECRET');
      expect(logged).toContain('https://***@github.com/o/r.git');
    }),
  );

  it(
    'leaves URLs without credentials untouched',
    withTempDir(async (cwd) => {
      const { logger, stdout } = captureConsole();
      await runLogged(
        run,
        node,
        ['-e', 'console.log("https://github.com/o/r.git")'],
        { cwd },
        logger,
      );
      expect(stdout()).toContain('\nhttps://github.com/o/r.git\n');
    }),
  );

  it(
    'rethrows an error that carries no credential in its message, stdout or stderr',
    withTempDir(async (cwd) => {
      const { logger } = captureConsole();
      const u = 'https://u:p@ss@host/x';
      const code = `console.log(${JSON.stringify(u)}); console.error(${JSON.stringify(u)}); process.exit(3)`;
      const failure = await runLogged(
        run,
        node,
        ['-e', code],
        { cwd },
        logger,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ status: 3 });
      const text = JSON.stringify(failure, Object.getOwnPropertyNames(failure));
      expect(text).not.toContain('ss@host');
      expect(text).toContain('https://***@host/x');
    }),
  );
});

describe('redactError', () => {
  it('redacts message, stdout and stderr and keeps code and status', () => {
    const original = Object.assign(new Error('failed https://u:pw0rd@h/x'), {
      code: 'E1',
      status: 3,
      stdout: 'out https://u:pw0rd@h/x',
      stderr: 'err ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const copy = redactError(original);
    expect(copy.message).toBe('failed https://***@h/x');
    expect(copy).toMatchObject({
      code: 'E1',
      status: 3,
      stdout: 'out https://***@h/x',
      stderr: 'err ***',
    });
  });

  it('wraps a thrown string', () => {
    expect(redactError('https://u:pw0rd@h/x').message).toBe('https://***@h/x');
  });
});
