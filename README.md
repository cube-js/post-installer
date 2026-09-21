# @cubejs-infra/post-installer

> Easiest way to download files on post installation step of you npm package.

# Usage example

1. First you need to define `resources` section under coresponding `package.json` file of your package.


```json
{
    "resources": {
        "files": [{
            "host": "https://github.com/cube-js/cube/releases/download/v${version}/",
            "path": "native-${platform}-${arch}-${libc}-${libpython_or_fallback}.tar.gz",
        }]
    }
}
```

# Additional

## Downloading plain files (no extraction)

By default the downloaded file is extracted into the package directory. Whether a file is
an archive is detected automatically from its mime type (resolved from the url via
[mime-types](https://www.npmjs.com/package/mime-types)): `application/gzip`,
`application/x-tar` and `application/zip` (`.tar.gz`, `.tgz`, `.tar`, `.zip`) are
extracted, anything else - a `.jar`, a `.node`, a bare binary - is downloaded as is.

For a file that is not extracted you must specify `dst` - a destination path relative to
the package directory. Missing directories are created, escaping the package directory is
not allowed.

```json
{
    "resources": {
        "files": [{
            "host": "https://repo1.maven.org/maven2/",
            "path": "org/slf4j/slf4j-api/${slf4j_version}/slf4j-api-${slf4j_version}.jar",
            "dst": "lib/slf4j.jar"
        }]
    }
}
```

`dst` supports the same variables as `host` & `path`.

Detection can be overridden with `extract`:

```json
{
    "host": "https://example.com/",
    "path": "bundle.tar.gz",
    "extract": false,
    "dst": "vendor/bundle.tar.gz"
}
```

For archives `dst` is ignored (they are always extracted into the package directory).


## Constraints

Variables and files supports contstraints, you can define it:

```
  "constraints": {
    "platform": [
      "linux"
    ],
    "arch": [
      "x64"
    ]
  }
```

Supported types:

- platform: `win32` / `darwin` / `linux` / `aix` / `android` / `freebsd` / `openbsd` / `cygwin`
- arch: `x64` / `arm64`
- platform-arch: `linux-x64`, etc.


## Variables

You can define and use variables in `path` & `host`.

```json
{
    "vars": {
      "libpython_or_fallback": {
        "default": "fallback",
        "value": [
          "libpython",
          [
            "3.11",
            "3.10",
            "3.9"
          ]
        ],
        "constraints": {
          "platform": [
            "linux"
          ],
          "arch": [
            "x64"
          ]
        }
      },
      "feature_or_default": {
        "default": "default",
        "value": [
          "env",
          "YOUR_ENV_NAME"
        ]
      }
    },
}
```

Next you can use this variable in the url via `/file/${libpython_or_fallback}.tar.gz`

# LICENSE

Apache-2.0
