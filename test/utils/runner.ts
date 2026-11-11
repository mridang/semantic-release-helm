import type { ExecOptions, Runner } from '../../src/utils/exec.js';

/**
 * One call made through a fake runner.
 */
export interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: ExecOptions | undefined;
}

/**
 * A runner that records its calls and answers from a function, so a client
 * can be tested without starting any program.
 * @param answer - Produces the stdout for a call, or throws to fail it.
 * @returns The runner and the list of calls it has received.
 */
export function fakeRunner(answer: (call: RecordedCall) => string = () => ''): {
  readonly run: Runner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const run: Runner = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    return answer(call);
  };
  return { run, calls };
}

/**
 * A logger that records everything written to it.
 * @returns The logger and the lines it has received.
 */
export function recordingLogger(): {
  readonly logger: {
    readonly log: (m: string) => void;
    readonly error: (m: string) => void;
  };
  readonly lines: string[];
} {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      log: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
}
