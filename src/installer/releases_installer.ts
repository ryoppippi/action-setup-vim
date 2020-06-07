import * as core from "@actions/core";
import {downloadTool} from "@actions/tool-cache";
import {Octokit, RestEndpointMethodTypes} from "@octokit/rest";
import semverCoerce = require("semver/functions/coerce");
import semverLte = require("semver/functions/lte");
import {SemVer} from "semver";
import {ActionError} from "../action_error";
import {FixedVersion, Installer, InstallType} from "../interfaces";

type TargetVersionResult = "skip" | "yes" | "done";
export type Release = RestEndpointMethodTypes["repos"]["listReleases"]["response"]["data"][number];

// semver disallow extra leading zero.
// v8.2.0000 -> v8.2.0
function adjustSemver(ver: string): string {
  return ver.replace(/\.0*(\d)/g, ".$1");
}

export function toSemver(ver: string): SemVer | null {
  if (/^v?\d/.test(ver)) {
    return semverCoerce(adjustSemver(ver));
  }
  return null;
}

export abstract class ReleasesInstaller implements Installer {
  abstract readonly repository: string;
  abstract readonly assetNamePattern: RegExp;
  abstract getExecutableName(): string;
  abstract toSemverString(release: Release): string;
  abstract async install(vimVersion: FixedVersion): Promise<void>;
  abstract getPath(vimVersion: FixedVersion): string;

  readonly installType = InstallType.download;
  readonly installDir: string;
  readonly isGUI: boolean;

  private _octokit?: Octokit;
  private releases: { [key: string]: Release } = {};

  constructor(installDir: string, isGUI: boolean) {
    this.installDir = installDir;
    this.isGUI = isGUI;
  }

  canInstall(_version: string): boolean {
    return true;
  }

  async resolveVersion(vimVersion: string): Promise<FixedVersion> {
    const [release, actualVersion] = await this.findRelease(vimVersion);
    this.releases[actualVersion] = release;
    return actualVersion as FixedVersion;
  }

  async findRelease(vimVersion: string): Promise<[Release, string]> {
    const [owner, repo] = this.repository.split("/");

    const isHead = vimVersion === "head";
    if (isHead) {
      let first = true;
      return await this.resolveVersionFromReleases(
        owner, repo,
        () => {
          if (first) {
            first = false;
            return "yes";
          }
          return "done";
        }
      );
    }

    const isLatest = vimVersion === "latest";
    if (isLatest) {
      const octokit = this.octokit();
      const {data: release} = await octokit.repos.getLatestRelease({owner, repo});
      return [release, release.tag_name];
    }

    const vimSemVer = toSemver(vimVersion);
    if (vimSemVer) {
      return await this.resolveVersionFromReleases(
        owner, repo,
        (release: Release) => {
          const releaseVersion = this.toSemverString(release);
          const releaseSemver = toSemver(releaseVersion);
          if (!releaseSemver) {
            return "skip";
          }
          return semverLte(vimSemVer, releaseSemver) ? "yes" : "done";
        }
      );
    } else {
      return await this.resolveVersionFromTag(owner, repo, vimVersion);
    }
  }

  private async resolveVersionFromReleases(
    owner: string,
    repo: string,
    getTargetVersion: (release: Release) => TargetVersionResult,
  ): Promise<[Release, string]> {
    const octokit = this.octokit();
    const releases: Release[] = [];
    for await (const {data: resReleases} of octokit.paginate.iterator(octokit.repos.listReleases, {owner, repo})) {
      for (const release of resReleases) {
        if (release.assets.length === 0) {
          continue;
        }
        const result = getTargetVersion(release);
        if (result === "skip") {
          continue;
        }
        if (result === "yes") {
          releases.push(release);
        } else {
          break;
        }
      }
    }

    if (releases.length === 0) {
      throw new ActionError("Target release not found");
    }

    const targetRelease = releases[releases.length - 1];
    const targetVersion = await this.perpetuateVersion(owner, repo, targetRelease);
    return [targetRelease, targetVersion];
  }

  private async resolveVersionFromTag(owner: string, repo: string, tag: string): Promise<[Release, string]> {
    const octokit = this.octokit();
    const {data: release} = await octokit.repos.getReleaseByTag({owner, repo, tag});
    const version = await this.perpetuateVersion(owner, repo, release);
    return [release, version];
  }

  private async perpetuateVersion(
    owner: string,
    repo: string,
    release: Release,
  ): Promise<string> {
    const version = this.toSemverString(release);
    if (toSemver(version)) {
      return version;
    }

    // We assume not a semver tag is a symbolized tag (e.g. "stable", "nightly")
    const octokit = this.octokit();
    const {data: res} = await octokit.git.getRef({owner, repo, ref: `tags/${release.tag_name}`});
    const targetSha = res.object.sha;

    // It may be released as numbered version.
    // Only check the first page
    const {data: releases} = await octokit.repos.listReleases({owner, repo});
    for (const release of releases) {
      const {tag_name: tagName} = release;
      if (!toSemver(tagName)) {
        continue;
      }
      const {data: refRes} = await octokit.git.getRef({owner, repo, ref: `tags/${tagName}`});
      let sha = refRes.object.sha;
      if (refRes.object.type === "tag") {
        const {data: tagRes} = await octokit.git.getTag({owner, repo, tag_sha: sha});
        sha = tagRes.object.sha;
      }
      if (sha === targetSha) {
        return tagName;
      }
    }
    // Fallback: treats sha1 as version.
    return targetSha;
  }

  async downloadAsset(vimVersion: FixedVersion): Promise<string> {
    const release = this.releases[vimVersion];
    if (!release) {
      throw new ActionError(`Unknown version: ${vimVersion}`);
    }
    const asset = release.assets.find(asset => this.assetNamePattern.test(asset.name));
    if (!asset) {
      const assetNames = release.assets.map(asset => asset.name);
      throw new ActionError(`Target asset not found: /${this.assetNamePattern.source}/ in ${JSON.stringify(assetNames)}`);
    }
    const url = asset.browser_download_url;
    return await downloadTool(url);
  }

  private octokit(): Octokit {
    if (!this._octokit) {
      this._octokit = new Octokit({auth: core.getInput("github_token")});
    }
    return this._octokit;
  }
}