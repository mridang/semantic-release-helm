import { quoteWord, shQuote } from './utils/shell.js';

/**
 * Inputs for the shell script that logs in to an OCI registry and pushes
 * the packaged charts.
 */
export interface OciScriptInput {
  readonly hostPort: string | undefined;
  readonly repo: string | undefined;
  readonly insecure: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly files: readonly string[];
}

/**
 * What to run in the Helm container, and with which environment variables.
 */
export interface OciPublish {
  readonly script: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Name of the container environment variable that carries the registry
 * password into the script, so it is never part of the script text.
 */
const OCI_PASSWORD_ENV = 'OCI_PASSWORD';

/**
 * Build the `/bin/sh` script run inside the Helm container to publish
 * charts to an OCI registry. Every interpolated value is single-quoted.
 * The password is read from the `OCI_PASSWORD` environment variable
 * instead of being written into the script, so neither the logged command
 * nor an error message can contain it.
 *
 * @param input Registry, credentials and packaged chart files.
 * @returns The script (commands joined with `&&`) and the environment to run
 *   it with, which holds the password when there is one.
 */
export function buildOciPublish(input: OciScriptInput): OciPublish {
  const { hostPort, repo, insecure, username, password, files } = input;
  const plainHttpFlag = insecure ? ' --plain-http' : '';
  const insecureLoginFlag = insecure ? ' --insecure' : '';
  const script = [
    ...(insecure && hostPort
      ? [
          'mkdir --parents /root/.config/helm/registry',
          `printf %s ${shQuote(`{"auths":{"${hostPort}":{"insecure":true}}}`)} > /root/.config/helm/registry/config.json`,
        ]
      : []),
    ...(username && password && hostPort
      ? [
          `helm registry login${insecureLoginFlag} --username=${quoteWord(username)} --password="$${OCI_PASSWORD_ENV}" ${quoteWord(hostPort)}`,
        ]
      : []),
    ...files.map(
      (tgz) =>
        `helm push ${quoteWord(tgz)} ${quoteWord(repo ?? '')}${plainHttpFlag}`,
    ),
  ].join(' && ');
  return { script, env: password ? { [OCI_PASSWORD_ENV]: password } : {} };
}
