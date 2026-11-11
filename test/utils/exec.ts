import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execAsync = promisify(exec);
export const execFileAsync = promisify(execFile);
