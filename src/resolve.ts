import {
  detectLibc,
  displayCLIWarning,
  libraryExists,
  LibraryExistsResult,
} from "@cubejs-backend/shared";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import * as process from "process";
import * as path from "path";
import { URL } from "url";
import * as mime from "mime-types";

export interface UrlVariable {
  resolve(url: string): string;
}

export interface ResolvedFile {
  url: string;
  name: string;
  extract: boolean;
}

export function resolveLibc(): string {
  if (process.platform === "linux") {
    return detectLibc() === "gnu" ? "glibc" : "musl";
  }

  return "unknown";
}

export function resolveConstraint(
  name: string,
  constraintDetails: any,
): boolean {
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

export function resolveConstraints(section: any): boolean {
  let constraintPass = true;

  if (section.constraints) {
    for (const [constraintName, constraintDetails] of Object.entries(
      section.constraints,
    )) {
      if (!resolveConstraint(constraintName, constraintDetails)) {
        constraintPass = false;
        break;
      }
    }
  }

  return constraintPass;
}

export function resolveVariableValue(value: any): string | false {
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

export function resolveVars(variables: Record<string, any>): UrlVariable[] {
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

export function resolveSimplePath(
  input: string,
  variables: UrlVariable[],
  version: string,
): string {
  input = input.replace("${version}", version);
  input = input.replace("${platform}", process.platform);
  input = input.replace("${arch}", process.arch);
  input = input.replace("${libc}", resolveLibc());

  for (const variable of variables) {
    input = variable.resolve(input);
  }

  return input;
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

export function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch (e) {
    return null;
  }
}

export function detectMimeType(url: string): string | false {
  // pathname keeps the query string and the hash out of the extension lookup
  const parsed = parseUrl(url);
  const pathname = parsed ? decodeURIComponent(parsed.pathname) : url;
  const extension = path.extname(pathname).toLowerCase().slice(1);

  return EXTRA_MIME_TYPES[extension] || mime.lookup(pathname);
}

// Detected from the resolved url, because the downloaded file is saved under a
// random name without an extension, and extractArchive throws on anything it
// doesn't recognize as an archive.
export function looksLikeArchive(url: string): boolean {
  const mimeType = detectMimeType(url);

  return mimeType !== false && EXTRACTABLE_MIME_TYPES.includes(mimeType);
}

export function resolveDst(
  file: any,
  variables: UrlVariable[],
  version: string,
  cwd: string,
): string | null {
  if (!file.dst) {
    return null;
  }

  const dst = resolveSimplePath(file.dst, variables, version);
  const root = path.resolve(cwd);
  const target = path.resolve(root, dst);

  if (target === root || !target.startsWith(root + path.sep)) {
    throw new Error(`dst must stay inside the package directory, got: ${dst}`);
  }

  return dst;
}

export const GITHUB_ARTIFACT_PROTOCOL = "github_artifact://";
// WHATWG URL rejects "_" in a scheme, so it is swapped for a valid one before parsing
const GITHUB_ARTIFACT_PARSABLE_PROTOCOL = "github-artifact://";

// github_artifact://<owner>/<repo>/actions/<workflow>
export function parseGithubArtifactUrl(url: string): {
  owner: string;
  repo: string;
} {
  const parsed = parseUrl(
    GITHUB_ARTIFACT_PARSABLE_PROTOCOL +
      url.slice(GITHUB_ARTIFACT_PROTOCOL.length),
  );
  const segments = parsed ? parsed.pathname.split("/").filter(Boolean) : [];
  const owner = parsed?.hostname;
  const [repo, actions, workflow] = segments;

  if (!owner || !repo || actions !== "actions" || !workflow) {
    throw new Error(
      `Unable to decode url from github_artifact protocol, expected ` +
        `${GITHUB_ARTIFACT_PROTOCOL}<owner>/<repo>/actions/<workflow>, got: ${url}`,
    );
  }

  return { owner, repo };
}

export async function resolveGithubArtifactPath(
  url: string,
  name: string,
  variables: UrlVariable[],
  version: string,
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

  const resolvedName = resolveSimplePath(name, variables, version);
  const artifactToDownload = listWorkflowRunArtifacts.data.artifacts.find(
    (artifact) => artifact.name === resolvedName,
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

export async function resolvePath(
  file: any,
  variables: UrlVariable[],
  version: string,
): Promise<ResolvedFile> {
  const extractOverride =
    typeof file.extract === "boolean" ? file.extract : null;

  if (file.host.startsWith(GITHUB_ARTIFACT_PROTOCOL)) {
    const resolved = await resolveGithubArtifactPath(
      file.host,
      file.name,
      variables,
      version,
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
    const url = resolveSimplePath(file.host + file.path, variables, version);

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
