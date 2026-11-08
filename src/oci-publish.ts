import { quoteWord, shQuote } from './docker/cli-client.js';

/**
 * Inputs for the shell script that logs in to an OCI registry and pushes
 * the packaged charts.
 */
export interface OciScriptInput {
  readonly hostPort: string | undefined;
  readonly repo: string | undefined;
  readonly insecure: boolean;
  readonly username: string | undefined;
  readonly hasPassword: boolean;
  readonly files: readonly string[];
}

/**
 * Name of the container environment variable that carries the registry
 * password into the script, so it is never part of the script text.
 */
export const OCI_PASSWORD_ENV = 'OCI_PASSWORD';

/**
 * Build the `/bin/sh` script run inside the Helm container to publish
 * charts to an OCI registry. Every interpolated value is single-quoted.
 * The password is read from the `OCI_PASSWORD` environment variable
 * instead of being written into the script, so neither the logged command
 * nor an error message can contain it.
 *
 * @param input Registry, credentials presence and packaged chart files.
 * @returns Commands joined with `&&`.
 */
export function buildOciScript(input: OciScriptInput): string {
  const { hostPort, repo, insecure, username, hasPassword, files } = input;
  const plainHttpFlag = insecure ? ' --plain-http' : '';
  const insecureLoginFlag = insecure ? ' --insecure' : '';
  return [
    ...(insecure && hostPort
      ? [
          'mkdir --parents /root/.config/helm/registry',
          `printf %s ${shQuote(`{"auths":{"${hostPort}":{"insecure":true}}}`)} > /root/.config/helm/registry/config.json`,
        ]
      : []),
    ...(username && hasPassword && hostPort
      ? [
          `helm registry login${insecureLoginFlag} --username=${quoteWord(username)} --password="$${OCI_PASSWORD_ENV}" ${quoteWord(hostPort)}`,
        ]
      : []),
    ...files.map(
      (tgz) =>
        `helm push ${quoteWord(tgz)} ${quoteWord(repo ?? '')}${plainHttpFlag}`,
    ),
  ].join(' && ');
}
