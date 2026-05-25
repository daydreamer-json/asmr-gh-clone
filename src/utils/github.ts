import fs from 'node:fs';
import { Octokit } from '@octokit/rest';
import logger from './logger.js';

async function uploadAsset(
  client: Octokit,
  owner: string,
  repo: string,
  tag: string,
  targetFileName: string,
  filePath: string,
) {
  const release = await getReleaseInfo(client, owner, repo, tag);
  if (!release) throw new Error('GH release not found');
  const releaseId = release.id;

  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const fileStream = fs.createReadStream(filePath);

  logger.info(`Mirror archive: Uploading to ${tag}, ${targetFileName} (${fileSize} bytes) ...`);
  const response = await client.rest.repos.uploadReleaseAsset({
    owner,
    repo,
    release_id: releaseId,
    name: targetFileName,
    data: fileStream as unknown as string, // Octokit internal handles ReadStream via string/buffer types
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': fileSize,
    },
  });
  return response.data.browser_download_url;
}

async function getReleaseInfo(client: Octokit, owner: string, repo: string, tag: string) {
  const { data: release } = await client.rest.repos.getReleaseByTag({ owner, repo, tag });
  return release;
}

async function createNewRelease(
  client: Octokit,
  owner: string,
  repo: string,
  tag: string,
  title: string,
  note: string,
  preRelFlag: boolean,
  draftFlag: boolean = false,
  targetCommitish: string = 'main',
) {
  const { data } = await client.rest.repos.createRelease({
    owner,
    repo,
    tag_name: tag,
    name: title,
    body: note,
    draft: draftFlag,
    prerelease: preRelFlag,
    target_commitish: targetCommitish,
  });
  return data;
}

async function deleteReleaseTag(client: Octokit, owner: string, repo: string, tag: string) {
  const { data: release } = await client.rest.repos.getReleaseByTag({ owner, repo, tag });
  await client.rest.repos.deleteRelease({ owner, repo, release_id: release.id });
  const data = await client.rest.git.deleteRef({ owner, repo, ref: `tags/${tag}` });
  return data;
}

export default {
  uploadAsset,
  getReleaseInfo,
  createNewRelease,
  deleteReleaseTag,
};
