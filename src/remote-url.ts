/**
 * A dotted host name or an IPv4 address. A scp-style remote whose host is
 * anything else (an `~/.ssh/config` alias such as `gh-work`, a Windows drive
 * letter, an IPv6 literal) cannot be vouched for as a web host.
 */
const WEB_HOST =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * The parts of a remote that a web link is built from.
 */
interface WebParts {
  readonly scheme: 'http:' | 'https:';
  readonly host: string;
  readonly pathname: string;
}

/**
 * Read an scp-style remote (`[user@]host:path`), accepting only a dotted
 * host name.
 *
 * @param host The text before the colon.
 * @param pathname The text after the colon.
 * @returns The parts, or undefined when the host is not a web host.
 */
function scpParts(host: string, pathname: string): WebParts | undefined {
  if (!WEB_HOST.test(host)) {
    return undefined;
  }
  return { scheme: 'https:', host, pathname };
}

/**
 * Read a URL remote.
 *
 * @param value The remote.
 * @returns The parts, or undefined when it is not an http, https, ssh or git
 *   URL with a host.
 */
function urlParts(value: string): WebParts | undefined {
  if (!URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  const web = url.protocol === 'http:' || url.protocol === 'https:';
  if (!web && url.protocol !== 'ssh:' && url.protocol !== 'git:') {
    return undefined;
  }
  if (url.hostname.length === 0) {
    return undefined;
  }
  if (url.protocol === 'http:') {
    return { scheme: 'http:', host: url.host, pathname: url.pathname };
  }
  if (web) {
    return { scheme: 'https:', host: url.host, pathname: url.pathname };
  }
  return { scheme: 'https:', host: url.hostname, pathname: url.pathname };
}

/**
 * The address of a git remote, as git prints it, with the credentials kept
 * out of everything it hands back. It knows how to turn itself into the
 * public web address of the repository.
 */
export class RemoteUrl {
  private readonly raw: string;

  private constructor(raw: string) {
    this.raw = raw.trim();
  }

  /**
   * Wrap the text of a remote URL, such as the output of
   * `git remote get-url`.
   *
   * @param text A remote URL: https, http, ssh, git, scp-style or a path.
   * @returns The remote URL.
   */
  static parse(text: string): RemoteUrl {
    return new RemoteUrl(text);
  }

  /**
   * The public web base of the repository, for building release links.
   * scp-style remotes are recognised first, as git does, then `https://`,
   * `http://`, `ssh://` and `git://` URLs. Credentials are dropped. An `http`
   * or `https` remote keeps its port; an ssh or git remote becomes `https` on
   * its host name. Nothing is guessed: local paths, `file://` remotes, drive
   * letters, ssh aliases and IPv6 literals yield undefined.
   *
   * @returns A URL such as `https://github.com/owner/repo`, or undefined.
   */
  webBase(): string | undefined {
    const scp = /^(?:[^@/:]+@)?([^:/@]+):(?!\/\/)(.+)$/.exec(this.raw);
    const parts = scp
      ? scpParts(scp[1] ?? '', scp[2] ?? '')
      : urlParts(this.raw);
    if (!parts) {
      return undefined;
    }
    const repoPath = parts.pathname
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.git$/, '');
    if (repoPath.length === 0) {
      return undefined;
    }
    return `${parts.scheme}//${parts.host}/${repoPath}`;
  }

  /**
   * The base for release download links. The release path used by the caller
   * is GitHub's, so the base derived from this remote is used only when its
   * host is github.com or is the host of the repository URL semantic-release
   * was configured with; otherwise the configured repository URL is used, and
   * when neither is usable there is no base.
   *
   * @param configured `options.repositoryUrl` from semantic-release, if any.
   * @returns A web base, or undefined when links cannot be built reliably.
   */
  releaseBase(configured: RemoteUrl | undefined): string | undefined {
    const own = this.webBase();
    const other = configured?.webBase();
    if (own === undefined) {
      return other;
    }
    const ownHost = new URL(own).hostname;
    if (ownHost === 'github.com') {
      return own;
    }
    if (other !== undefined && new URL(other).hostname === ownHost) {
      return own;
    }
    return other;
  }

  /**
   * The URL with any user and password replaced, safe to log.
   *
   * @returns The redacted text.
   */
  toString(): string {
    return this.raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, '$1***@');
  }
}
