#!/usr/bin/env node

import "source-map-support/register";

import {
  displayCLIError,
  displayCLIWarning,
  downloadAndExtractFile,
} from "@cubejs-backend/shared";
import * as process from "process";
import * as fs from "fs";
import * as path from "path";
import {
  resolveConstraints,
  resolveDst,
  resolvePath,
  resolveVars,
} from "./resolve";

const packageContent = fs.readFileSync(
  path.join(process.cwd(), "package.json"),
  "utf8",
);
const pkg = JSON.parse(packageContent);

(async () => {
  try {
    if (!pkg.resources) {
      throw new Error(
        "Please defined resources section in package.json file in corresponding package",
      );
    }

    const cwd = process.cwd();
    const variables = resolveVars(pkg.resources.vars || []);

    for (const file of pkg.resources.files) {
      if (!resolveConstraints(file)) {
        console.log(
          `Skiping downloading for ${
            file.name || file.path || file.host
          }: constraints failed`,
        );

        continue;
      }

      const toDownload = await resolvePath(file, variables, pkg.version);
      const dst = resolveDst(file, variables, pkg.version, cwd);

      if (toDownload.extract) {
        if (dst) {
          displayCLIWarning(
            `dst is ignored for ${toDownload.name}, because it is extracted into the package directory`,
          );
        }

        console.log(`Downloading: ${toDownload.name}`);

        await downloadAndExtractFile(toDownload.url, {
          cwd,
          showProgress: true,
        });
      } else {
        if (!dst) {
          throw new Error(
            `dst is required for ${toDownload.name}, because it is downloaded without extraction`,
          );
        }

        // downloadAndExtractFile creates cwd, but not subdirectories of dstFileName
        fs.mkdirSync(path.dirname(path.resolve(cwd, dst)), {
          recursive: true,
        });

        console.log(`Downloading: ${toDownload.name} -> ${dst}`);

        await downloadAndExtractFile(toDownload.url, {
          cwd,
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
