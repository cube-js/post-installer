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
    let value = variable["default"];

    let constraintPass = resolveConstraints(variable);
    if (constraintPass) {
      if (variable.value) {
        const resolvedValue = resolveVariableValue(variable.value);
        if (resolvedValue) {
          value = resolvedValue;
        }
      }
    }

    res.push({
      resolve(url: string): string {
        url = url.replace("${" + variableName + "}", value);

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

function resolvePath(path: string, variables: UrlVariable[]): string {
  path = path.replace("${version}", pkg.version);
  path = path.replace("${platform}", process.platform);
  path = path.replace("${arch}", process.arch);
  path = path.replace("${libc}", resolveLibc());

  for (const variable of variables) {
    path = variable.resolve(path);
  }

  return path;
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
      const url = resolvePath(file.host + file.path, variables);

      let constraintPass = resolveConstraints(file);
      if (constraintPass) {
        console.log(`Downloading: ${url}`);

        await downloadAndExtractFile(url, {
          cwd: process.cwd(),
          showProgress: true,
        });
      } else {
        console.log(`Skiping downloading for ${file.path}: constraints failed`);
      }
    }
  } catch (e: any) {
    await displayCLIError(e, "Native Installer");
  }
})();
