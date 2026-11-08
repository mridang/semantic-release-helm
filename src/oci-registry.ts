import type { ChartPackage } from './chart-package.js';
import type { DockerImage } from './docker.js';
import { quoteWord, shQuote } from './utils/shell.js';

/**
 * A chart that was pushed to a registry.
 */
export interface PublishedChart {
  /** The repository it was pushed to, such as `oci://registry/charts`. */
  readonly reference: string;
  /** The package that was pushed. */
  readonly package: ChartPackage;
  /** The digest the registry reported, when Helm printed one. */
  readonly digest: string | undefined;
}

/**
 * Settings of an OCI registry handle.
 */
export interface OciRegistryOptions {
  /** Repository URL, such as `oci://registry.example.test/charts`. */
  readonly repo: string;
  /** `host` or `host:port` of the registry. */
  readonly hostPort: string | undefined;
  /** Whether to talk plain HTTP and skip TLS verification. */
  readonly insecure: boolean;
  /** Registry user name, if logging in. */
  readonly username: string | undefined;
  /** Registry password, if logging in. It only travels in the environment. */
  readonly password: string | undefined;
  /** The image with the Helm CLI. */
  readonly helm: DockerImage;
  /** Repository root, the base of package paths inside the container. */
  readonly cwd: string;
}

/**
 * Name of the container environment variable that carries the registry
 * password into the script, so it is never part of the script text.
 */
const PASSWORD_ENV = 'OCI_PASSWORD';

/**
 * An OCI registry that charts are published to.
 */
export class OciRegistry {
  private readonly options: OciRegistryOptions;

  /**
   * @param options Repository, credentials, insecure mode, the Helm image and
   *   the repository root.
   */
  constructor(options: OciRegistryOptions) {
    this.options = options;
  }

  /**
   * Log in when credentials are given, and push a package. The password
   * reaches the container only through its environment, so it appears in no
   * script, command line or log.
   *
   * @param pkg The packaged chart.
   * @returns The published chart, with the digest Helm printed if any.
   */
  async publish(pkg: ChartPackage): Promise<PublishedChart> {
    const output = await this.options.helm.run(['-lc', this.script(pkg)], {
      entrypoint: '/bin/sh',
      env: this.environment(),
    });
    return {
      reference: this.options.repo,
      package: pkg,
      digest: /Digest:\s*(sha256:[0-9a-f]+)/i.exec(output)?.[1],
    };
  }

  /**
   * The container environment: the password when there is one.
   *
   * @returns The variables to pass.
   */
  private environment(): Readonly<Record<string, string>> {
    const { password } = this.options;
    if (password === undefined) {
      return {};
    }
    return { [PASSWORD_ENV]: password };
  }

  /**
   * Build the `/bin/sh` script run inside the Helm container. A shell is
   * needed there because the steps are chained; every interpolated value is
   * single-quoted when it needs it. The password is read from the
   * environment instead of being written into the script.
   *
   * @param pkg The package to push.
   * @returns Commands joined with `&&`.
   */
  private script(pkg: ChartPackage): string {
    const { repo, insecure, cwd } = this.options;
    const plainHttp = insecure ? ' --plain-http' : '';
    return [
      ...this.configSteps(),
      ...this.loginSteps(),
      `helm push ${quoteWord(pkg.relativeTo(cwd))} ${quoteWord(repo)}${plainHttp}`,
    ].join(' && ');
  }

  /**
   * The steps that write the insecure registry config for Helm.
   *
   * @returns The steps, empty unless insecure mode and a host are set.
   */
  private configSteps(): string[] {
    const { hostPort, insecure } = this.options;
    if (!insecure || !hostPort) {
      return [];
    }
    const configDir = '/root/.config/helm/registry';
    return [
      `mkdir --parents ${configDir}`,
      `printf %s ${shQuote(`{"auths":{"${hostPort}":{"insecure":true}}}`)} > ${configDir}/config.json`,
    ];
  }

  /**
   * The step that logs in, reading the password from the environment.
   *
   * @returns The step, empty unless a username, password and host are set.
   */
  private loginSteps(): string[] {
    const { hostPort, insecure, username, password } = this.options;
    if (!username || !password || !hostPort) {
      return [];
    }
    const insecureLogin = insecure ? ' --insecure' : '';
    return [
      `helm registry login${insecureLogin} --username=${quoteWord(username)} --password="$${PASSWORD_ENV}" ${quoteWord(hostPort)}`,
    ];
  }
}
