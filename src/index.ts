#!/usr/bin/env node

import "source-map-support/register";

import {
  detectLibc,
  displayCLIError,
  displayCLIWarning,
  downloadAndExtractFile,
  libraryExists,
  LibraryExistsResult,
} from "@cubejs-backend/shared";
import * as process from "process";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import * as mime from "mime-types";

const packageContent = fs.readFileSync(
  path.join(process.cwd(), "package.json"),
  "utf8"
);
const pkg = JSON.parse(packageContent);

interface UrlVariable {
  resolve(url: string): string;
}

function resolveConstraint(name: string, constraintDetails: any): boolean {
  if (name === "platform") {
    return constraintDetails.includes(process.platform);
  }

  if (name === "arch") {
    return constraintDetails.includes(process.arch);
  }

  if (name === "platform-arch") {
    return constraintDetails.includes(`${process.platform}-${process.arch}`);
  }

  displayCLIWarning(`Unknown constraint name: ${name}, pass: false`);

  return false;
}

function resolveVariableValue(value: any): string | false {
  if (Array.isArray(value) && value.length == 2) {
    const [valueName, supportedVersions] = value;
    if (valueName === "libpython") {
      for (const version of supportedVersions) {
        if (
          libraryExists(`libpython${version}`) === LibraryExistsResult.Exists
        ) {
          return version;
        }
      }

      return false;
    }
  }

  if (Array.isArray(value) && value.length == 2) {
    const [valueName, env_name] = value;
    if (valueName === "env") {
      return process.env[env_name] || false;
    }
  }

  if (value === "libc") {
    return resolveLibc();
  }

  displayCLIWarning(`Unable to resolve value, unknown value ${value}`);

  return false;
}

function resolveConstraints(section: any): boolean {
  let constraintPass = true;

  if (section.constraints) {
    for (const [constraintName, constraintDetails] of Object.entries(
      section.constraints
    )) {
      if (!resolveConstraint(constraintName, constraintDetails)) {
        constraintPass = false;
        break;
      }
    }
  }

  return constraintPass;
}

function resolveVars(variables: Record<string, any>): UrlVariable[] {
  const res = [];

  for (const [variableName, variable] of Object.entries(variables)) {
    let value: string | null = null;

    let constraintPass = resolveConstraints(variable);
    if (constraintPass) {
      if (variable.value) {
        const resolvedValue = resolveVariableValue(variable.value);
        if (resolvedValue) {
          value = resolvedValue;
        }
      }
    }

    if (!value) {
      if ("default" in variable) {
        value = variable["default"];
      } else {
        throw new Error(`Unable to resolve variable ${variableName}`);
      }
    }

    res.push({
      resolve(url: string): string {
        url = url.replace("${" + variableName + "}", value as string);

        return url;
      },
    });
  }

  return res;
}

function resolveLibc(): string {
  if (process.platform === "linux") {
    return detectLibc() === "gnu" ? "glibc" : "musl";
  }

  return "unknown";
}

import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";

function resolveSimplePath(path: string, variables: UrlVariable[]): string {
  path = path.replace("${version}", pkg.version);
  path = path.replace("${platform}", process.platform);
  path = path.replace("${arch}", process.arch);
  path = path.replace("${libc}", resolveLibc());

  for (const variable of variables) {
    path = variable.resolve(path);
  }

  return path;
}

// mime-db has no entry for the compressed-tar shorthands
const EXTRA_MIME_TYPES: Record<string, string> = {
  tgz: "application/gzip",
  tbz2: "application/x-bzip2",
  txz: "application/x-xz",
};

// Formats extractArchive() from @cubejs-backend/shared is able to unpack.
// Zip containers that are consumed as a single file (jar, whl, apk, ...) are
// deliberately not here, they have their own mime types.
const EXTRACTABLE_MIME_TYPES = [
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/zip",
];

function detectMimeType(url: string): string | false {
  // pathname keeps the query string and the hash out of the extension lookup
  const parsed = parseUrl(url);
  const pathname = parsed ? decodeURIComponent(parsed.pathname) : url;
  const extension = path.extname(pathname).toLowerCase().slice(1);

  return EXTRA_MIME_TYPES[extension] || mime.lookup(pathname);
}

// Detected from the resolved url, because the downloaded file is saved under a
// random name without an extension, and extractArchive throws on anything it
// doesn't recognize as an archive.
function looksLikeArchive(urlOrPath: string): boolean {
  const mimeType = detectMimeType(urlOrPath);

  return mimeType !== false && EXTRACTABLE_MIME_TYPES.includes(mimeType);
}

function resolveDst(file: any, variables: UrlVariable[]): string | null {
  if (!file.dst) {
    return null;
  }

  const dst = resolveSimplePath(file.dst, variables);
  const cwd = path.resolve(process.cwd());
  const target = path.resolve(cwd, dst);

  if (target !== cwd && !target.startsWith(cwd + path.sep)) {
    throw new Error(`dst must stay inside the package directory, got: ${dst}`);
  }

  return dst;
}

const GITHUB_ARTIFACT_PROTOCOL = "github_artifact://";
// WHATWG URL rejects "_" in a scheme, so it is swapped for a valid one before parsing
const GITHUB_ARTIFACT_PARSABLE_PROTOCOL = "github-artifact://";

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch (e) {
    return null;
  }
}

// github_artifact://<owner>/<repo>/actions/<workflow>
function parseGithubArtifactUrl(url: string): { owner: string; repo: string } {
  const parsed = parseUrl(
    GITHUB_ARTIFACT_PARSABLE_PROTOCOL +
      url.slice(GITHUB_ARTIFACT_PROTOCOL.length)
  );
  const segments = parsed ? parsed.pathname.split("/").filter(Boolean) : [];
  const owner = parsed?.hostname;
  const [repo, actions, workflow] = segments;

  if (!owner || !repo || actions !== "actions" || !workflow) {
    throw new Error(
      `Unable to decode url from github_artifact protocol, expected ` +
        `${GITHUB_ARTIFACT_PROTOCOL}<owner>/<repo>/actions/<workflow>, got: ${url}`
    );
  }

  return { owner, repo };
}

async function resolveGithubArtifactPath(
  url: string,
  name: string,
  variables: UrlVariable[]
): Promise<{ url: string; name: string }> {
  const { owner, repo } = parseGithubArtifactUrl(url);

  const MyOctokit = Octokit.plugin(restEndpointMethods);
  const ghClient = new MyOctokit({
    auth: process.env.GH_TOKEN,
  });

  const listWorkflowRunArtifacts =
    await ghClient.rest.actions.listWorkflowRunArtifacts({
      owner,
      repo,
      run_id: process.env.GITHUB_RUN_ID as any,
    });

  const resolvedName = resolveSimplePath(name, variables);
  const artifactToDownload = listWorkflowRunArtifacts.data.artifacts.find(
    (artifact) => artifact.name === resolvedName
  );
  if (!artifactToDownload) {
    throw new Error(`Artifact '${resolvedName}' doesn't exist`);
  }

  const arhiveUrl = await ghClient.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifactToDownload.id,
    archive_format: "zip",
  });

  return {
    url: arhiveUrl.url,
    name: resolvedName,
  };
}

async function resolvePath(
  file: any,
  variables: UrlVariable[]
): Promise<{ url: string; name: string; extract: boolean }> {
  const extractOverride =
    typeof file.extract === "boolean" ? file.extract : null;

  if (file.host.startsWith(GITHUB_ARTIFACT_PROTOCOL)) {
    const resolved = await resolveGithubArtifactPath(
      file.host,
      file.name,
      variables
    );

    return {
      ...resolved,
      // GitHub always packs artifacts into a zip
      extract: extractOverride ?? true,
    };
  } else if (
    file.host.startsWith("http://") ||
    file.host.startsWith("https://")
  ) {
    const url = resolveSimplePath(file.host + file.path, variables);

    return {
      url,
      // Use the same
      name: url,
      extract: extractOverride ?? looksLikeArchive(url),
    };
  } else {
    throw new Error(`Unsupported protocol in path: ${file.host}`);
  }
}

(async () => {
  try {
    if (!pkg.resources) {
      throw new Error(
        "Please defined resources section in package.json file in corresponding package"
      );
    }

    const variables = resolveVars(pkg.resources.vars || []);

    for (const file of pkg.resources.files) {
      if (!resolveConstraints(file)) {
        console.log(
          `Skiping downloading for ${
            file.name || file.path || file.host
          }: constraints failed`
        );

        continue;
      }

      const toDownload = await resolvePath(file, variables);
      const dst = resolveDst(file, variables);

      if (toDownload.extract) {
        if (dst) {
          displayCLIWarning(
            `dst is ignored for ${toDownload.name}, because it is extracted into the package directory`
          );
        }

        console.log(`Downloading: ${toDownload.name}`);

        await downloadAndExtractFile(toDownload.url, {
          cwd: process.cwd(),
          showProgress: true,
        });
      } else {
        if (!dst) {
          throw new Error(
            `dst is required for ${toDownload.name}, because it is downloaded without extraction`
          );
        }

        // downloadAndExtractFile creates cwd, but not subdirectories of dstFileName
        fs.mkdirSync(path.dirname(path.resolve(process.cwd(), dst)), {
          recursive: true,
        });

        console.log(`Downloading: ${toDownload.name} -> ${dst}`);

        await downloadAndExtractFile(toDownload.url, {
          cwd: process.cwd(),
          showProgress: true,
          skipExtract: true,
          dstFileName: dst,
        });
      }
    }
  } catch (e: any) {
    await displayCLIError(e, "Native Installer");
    process.exit(1);
  }
})();
