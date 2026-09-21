import * as path from "path";
import { describe, expect, it } from "vitest";

import {
  detectMimeType,
  looksLikeArchive,
  parseGithubArtifactUrl,
  resolveConstraints,
  resolveDst,
  resolvePath,
  resolveSimplePath,
  resolveVars,
  UrlVariable,
} from "../src/resolve";

const VERSION = "1.2.3";

describe("looksLikeArchive", () => {
  it.each([
    "https://example.com/native.tar.gz",
    "https://example.com/native.tgz",
    "https://example.com/native.TGZ",
    "https://example.com/native.tar",
    "https://example.com/native.zip",
    "https://example.com/native.zip?token=secret",
    "https://example.com/native.zip#fragment",
  ])("extracts %s", (url) => {
    expect(looksLikeArchive(url)).toBe(true);
  });

  it.each([
    // a zip container, but consumed as a single file
    "https://example.com/driver.jar",
    "https://example.com/native.node",
    "https://example.com/libnative.so",
    "https://example.com/pkg-1.0-py3-none-any.whl",
    // no extension at all
    "https://example.com/cube-js/post-installer/zip/refs/heads/master",
    // supported by neither extractArchive nor us
    "https://example.com/native.tar.bz2",
  ])("downloads %s as is", (url) => {
    expect(looksLikeArchive(url)).toBe(false);
  });

  it("does not take the extension from the query string", () => {
    expect(detectMimeType("https://example.com/download?file=x.zip")).toBe(
      false,
    );
  });

  it("falls back to the raw string when the url is unparsable", () => {
    expect(detectMimeType("not a url at all/native.zip")).toBe(
      "application/zip",
    );
  });
});

describe("parseGithubArtifactUrl", () => {
  it("parses owner and repo", () => {
    expect(
      parseGithubArtifactUrl(
        "github_artifact://cube-js/post-installer/actions/current",
      ),
    ).toEqual({ owner: "cube-js", repo: "post-installer" });
  });

  it("keeps uppercase and allows underscores, unlike the previous regexp", () => {
    expect(
      parseGithubArtifactUrl(
        "github_artifact://Cube-JS/post_installer2/actions/current",
      ),
    ).toEqual({ owner: "Cube-JS", repo: "post_installer2" });
  });

  it.each([
    "github_artifact://cube-js/post-installer",
    "github_artifact://cube-js/post-installer/runs/current",
    "github_artifact://cube-js/post-installer/actions",
    "github_artifact://",
  ])("throws on %s", (url) => {
    expect(() => parseGithubArtifactUrl(url)).toThrowError(
      /Unable to decode url from github_artifact protocol/,
    );
  });
});

describe("resolveSimplePath", () => {
  it("substitutes the built-in variables", () => {
    expect(
      resolveSimplePath(
        "native-${version}-${platform}-${arch}.tar.gz",
        [],
        VERSION,
      ),
    ).toBe(`native-${VERSION}-${process.platform}-${process.arch}.tar.gz`);
  });

  it("substitutes user defined variables", () => {
    const variables = resolveVars({
      libpython_version: { default: "fallback" },
    });

    expect(
      resolveSimplePath("native-${libpython_version}.node", variables, VERSION),
    ).toBe("native-fallback.node");
  });
});

describe("resolveVars", () => {
  it("falls back to the default when there is no value", () => {
    const variables = resolveVars({ feature: { default: "off" } });

    expect(resolveSimplePath("${feature}", variables, VERSION)).toBe("off");
  });

  it("reads a value from an env variable", () => {
    process.env.POST_INSTALLER_TEST_VAR = "on";

    try {
      const variables = resolveVars({
        feature: { default: "off", value: ["env", "POST_INSTALLER_TEST_VAR"] },
      });

      expect(resolveSimplePath("${feature}", variables, VERSION)).toBe("on");
    } finally {
      delete process.env.POST_INSTALLER_TEST_VAR;
    }
  });

  it("uses the default when the constraints do not pass", () => {
    const variables = resolveVars({
      feature: {
        default: "off",
        value: ["env", "PATH"],
        constraints: { platform: ["definitely-not-a-platform"] },
      },
    });

    expect(resolveSimplePath("${feature}", variables, VERSION)).toBe("off");
  });

  it("throws when a variable cannot be resolved and has no default", () => {
    expect(() =>
      resolveVars({ feature: { value: ["env", "POST_INSTALLER_MISSING"] } }),
    ).toThrowError("Unable to resolve variable feature");
  });
});

describe("resolveConstraints", () => {
  it("passes when there are no constraints", () => {
    expect(resolveConstraints({})).toBe(true);
  });

  it("matches platform, arch and platform-arch", () => {
    expect(
      resolveConstraints({
        constraints: {
          platform: [process.platform],
          arch: [process.arch],
          "platform-arch": [`${process.platform}-${process.arch}`],
        },
      }),
    ).toBe(true);
  });

  it("fails when one of the constraints does not match", () => {
    expect(
      resolveConstraints({
        constraints: { platform: [process.platform], arch: ["pdp11"] },
      }),
    ).toBe(false);
  });

  it("fails on an unknown constraint", () => {
    expect(resolveConstraints({ constraints: { os: ["linux"] } })).toBe(false);
  });
});

describe("resolveDst", () => {
  const cwd = path.resolve("/tmp/post-installer-tests");

  it("returns null when dst is not set", () => {
    expect(resolveDst({}, [], VERSION, cwd)).toBeNull();
  });

  it("substitutes variables", () => {
    expect(
      resolveDst({ dst: "lib/native-${version}.jar" }, [], VERSION, cwd),
    ).toBe(`lib/native-${VERSION}.jar`);
  });

  it.each(["../evil.jar", "lib/../../evil.jar", "/etc/evil.jar", "."])(
    "rejects %s",
    (dst) => {
      expect(() => resolveDst({ dst }, [], VERSION, cwd)).toThrowError(
        /dst must stay inside the package directory/,
      );
    },
  );
});

describe("resolvePath", () => {
  const variables: UrlVariable[] = [];

  it("marks an archive as extractable", async () => {
    await expect(
      resolvePath(
        { host: "https://example.com/", path: "native-${version}.tar.gz" },
        variables,
        VERSION,
      ),
    ).resolves.toEqual({
      url: `https://example.com/native-${VERSION}.tar.gz`,
      name: `https://example.com/native-${VERSION}.tar.gz`,
      extract: true,
    });
  });

  it("marks a plain file as not extractable", async () => {
    const resolved = await resolvePath(
      { host: "https://example.com/", path: "driver.jar" },
      variables,
      VERSION,
    );

    expect(resolved.extract).toBe(false);
  });

  it.each([
    { extract: false, path: "native.tar.gz" },
    { extract: true, path: "driver.jar" },
  ])("honours an explicit extract: $extract", async ({ extract, path }) => {
    const resolved = await resolvePath(
      { host: "https://example.com/", path, extract },
      variables,
      VERSION,
    );

    expect(resolved.extract).toBe(extract);
  });

  it("throws on an unsupported protocol", async () => {
    await expect(
      resolvePath(
        { host: "ftp://example.com/", path: "x.zip" },
        variables,
        VERSION,
      ),
    ).rejects.toThrowError("Unsupported protocol in path: ftp://example.com/");
  });
});
