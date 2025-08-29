# Semantic Release - Helm

A [semantic-release](https://github.com/semantic-release/semantic-release)
plugin to automatically package and publish Helm charts to an
OCI-compliant registry or publish them to GitHub Pages.

This plugin automates the final step of a Helm chart release workflow.
It updates the `version` in your `Chart.yaml` file, validates and templates
your chart, regenerates the chart `README.md` via `helm-docs`, packages the
chart into a `.tgz`, and after `semantic-release` publishes a new Git tag,
it pushes the packaged chart either to your configured OCI registry or to
GitHub Pages. This eliminates the need for manual commands or scripts, ensuring
your Helm charts are always up-to-date and published consistently.

## Why?

Automating the release of a Helm chart involves more than just creating a Git tag.
For a new version to be consumable, it must be validated, packaged, and pushed
to a chart registry. This final synchronization step is a common point of friction
in an otherwise automated pipeline.

Without this plugin, developers typically face one of two issues:

- **Manual Helm Workflow:** The most common method is manually running
  `helm lint`, `helm package`, and `helm push`. This adds toil and
  creates opportunities for mistakes or skipped steps.
- **Incomplete Automation:** Other existing plugins may bump the version in
  `Chart.yaml`, but they often stop there. They do not handle linting,
  templating, regenerating docs, or pushing to OCI/GitHub Pages. This leaves
  a manual gap in the release process.
- **Missing Validation:** Many pipelines skip running `helm lint` and
  `helm template`, which can allow broken charts to be released. This
  results in consumers discovering issues after the release, rather than
  catching them during CI.

This plugin provides a lightweight and direct solution by running Helm and
helm-docs inside Docker. Instead of relying on ad-hoc scripts, it ensures
that after `semantic-release` successfully creates a new release, your Helm
chart is linted, templated, documented, packaged, and immediately published
to your target registry.

## Installation

Install using NPM with the following command:

```sh
npm install --save-dev @mridang/semantic-release-helm
```

## Usage

To use this plugin, add it to your semantic-release configuration file
(e.g., `.releaserc.js`, `release.config.js`, or in your `package.json`).

The plugin’s `prepare` step modifies your `Chart.yaml`, regenerates
the `README.md` file, and packages the chart. For these changes to be
included in the release commit, the plugin should be placed **before**
`@semantic-release/git` and `@semantic-release/github` in the `plugins` array.

> [!IMPORTANT]
> This plugin updates the `version` field in your `Chart.yaml` file during the
> `prepare` step. For this change to be included in your release commit,
> you **must** configure the `@semantic-release/git` plugin to add
> `Chart.yaml` (and optionally `README.md`) to its `assets` array.

### Example Configuration (`.releaserc.js`)

```javascript
module.exports = {
  branches: ['main', 'next'],
  plugins: [
    '@semantic-release/commit-analyzer',
    [
      '@mridang/semantic-release-helm',
      {
        chartPath: 'charts/app',
        ociRepo: 'oci://ghcr.io/my-org/charts',
        ociUsername: process.env.OCI_USERNAME,
        ociPassword: process.env.OCI_PASSWORD,
        ociInsecure: false,
        helmImage: 'alpine/helm:3.15.2',
        docsImage: 'jnorwood/helm-docs:v1.14.2',
        docsArgs: ['--template-files', 'README.md'],
        githubPages: true,
      },
    ],
    '@semantic-release/release-notes-generator',
    '@semantic-release/changelog',
    '@semantic-release/github',
    [
      '@semantic-release/git',
      {
        assets: [
          'charts/app/Chart.yaml',
          'charts/app/README.md',
          'CHANGELOG.md',
        ],
        message:
          'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
  ],
};
```

### Configuration Options

All options are case-sensitive and lowercased in the JSON configuration.

- **`chartPath` (string, required):**
  Path to the chart directory containing `Chart.yaml`.

- **`ociRepo` (string, optional):**
  The target OCI repository (e.g., `oci://ghcr.io/my-org/charts`).
  When configured, the packaged chart will be pushed to this repository.

- **`ociUsername` (string, optional):**
  Username for authenticating with the OCI registry. If not provided,
  anonymous push will be attempted (not recommended).

- **`ociPassword` (string, optional):**
  Password or token for authenticating with the OCI registry.

- **`ociInsecure` (boolean, optional):**
  If `true`, allows pushing to insecure HTTP registries. Default: `false`.

- **`helmImage` (string, optional):**
  Custom Docker image for running Helm commands. Default:
  `alpine/helm:3.15.2`.

- **`docsImage` (string, optional):**
  Custom Docker image for running helm-docs. Default:
  `jnorwood/helm-docs:v1.14.2`.

- **`docsArgs` (array of strings, optional):**
  Additional arguments for helm-docs. Default:
  `['--template-files', 'README.md']`.

- **`githubPages` (boolean, optional):**
  If `true`, the packaged chart will also be pushed to the `gh-pages` branch
  of the repository, making it available as a Helm chart repo over GitHub Pages.

## OCI Registry Publishing

When you provide `ociRepo`, the plugin will package your chart into a `.tgz`
and execute `helm push` to the specified OCI-compliant registry. Credentials
are taken from `ociUsername` and `ociPassword`. This enables direct integration
with container registries such as GitHub Container Registry (`ghcr.io`),
Amazon ECR, or Docker Hub (if they support OCI artifacts).

## GitHub Pages Publishing

If `githubPages` is enabled, the plugin will push the packaged chart to the
`gh-pages` branch of the repository. This is useful if you want to host
your Helm charts via GitHub Pages as a traditional Helm chart repository.
Consumers can then add your repo with:

```sh
helm repo add my-org https://my-org.github.io/my-repo/
```

## Known Issues

- None.

## Useful links

- **[Helm](https://helm.sh/):** The Kubernetes package manager.
- **[helm-docs](https://github.com/norwoodj/helm-docs):** Tool for automatically generating chart documentation.

## Contributing

If you have suggestions for how this plugin could be improved, or
want to report a bug, open an issue — we’d love all and any
contributions.

## License

Apache License 2.0 © 2024 Mridang Agarwalla
