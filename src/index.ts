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

async function resolveGithubArtifactPath(
  url: string,
  name: string,
  variables: UrlVariable[]
): Promise<{ url: string; name: string }> {
  const extractParamsRegexp =
    /github_artifact:\/\/(?<owner>[a-z-]+)\/(?<repo>[a-z-]+)\/actions\/(?<workflow>[a-zA-Z${}]+)/;

  const params = url.match(extractParamsRegexp);

  const MyOctokit = Octokit.plugin(restEndpointMethods);
  const ghClient = new MyOctokit({
    auth: process.env.GH_TOKEN,
  });

  if (!params || !("groups" in params)) {
    throw new Error("Unable to decode url from github_artifact protocol");
  }

  const listWorkflowRunArtifacts =
    await ghClient.rest.actions.listWorkflowRunArtifacts({
      owner: params.groups?.owner as any,
      repo: params.groups?.repo as any,
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
    owner: params.groups?.owner as any,
    repo: params.groups?.repo as any,
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
): Promise<{ url: string; name: string }> {
  if (file.host.startsWith("github_artifact://")) {
    return resolveGithubArtifactPath(file.host, file.name, variables);
  } else if (
    file.host.startsWith("http://") ||
    file.host.startsWith("https://")
  ) {
    const url = resolveSimplePath(file.host + file.path, variables);

    return {
      url,
      // Use the same
      name: url,
    };
  } else {
    throw new Error(`Unsupported protocol in path: ${path}`);
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
      const toDownload = await resolvePath(file, variables);

      let constraintPass = resolveConstraints(file);
      if (constraintPass) {
        console.log(`Downloading: ${toDownload.name}`);

        await downloadAndExtractFile(toDownload.url, {
          cwd: process.cwd(),
          showProgress: true,
        });
      } else {
        console.log(
          `Skiping downloading for ${toDownload.name}: constraints failed`
        );
      }
    }
  } catch (e: any) {
    await displayCLIError(e, "Native Installer");
    process.exit(1);
  }
})();
