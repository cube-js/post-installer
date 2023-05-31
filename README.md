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

## Constraints



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
      }
    },
}
```

Next you can use this variable in the url via `/file/${libpython_or_fallback}.tar.gz`

# LICENSE

Apache-2.0
