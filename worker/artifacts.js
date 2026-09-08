import { ARTIFACT_PREFIX, MAX_ARTIFACT_BYTES, GITHUB_OWNER, GITHUB_REPOSITORY, positiveInteger } from "./config.js";
import { HttpError, GitHubError, secureResponse } from "./responses.js";
import { githubJson, githubRawArtifact } from "./github.js";

export async function findArtifact(env, run, requestId) {
  const runId = positiveInteger(run?.id);
  const attempt = positiveInteger(run?.run_attempt);
  if (!runId || !attempt) throw new HttpError(502, "GitHub Actions 运行版本无效", "github_run_invalid");
  const payload = await githubJson(
    env,
    `/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/actions/runs/${runId}/artifacts`,
    { query: { per_page: 100 } },
  );
  const expected = `${ARTIFACT_PREFIX}-${requestId}-${runId}-${attempt}`;
  const matches = (Array.isArray(payload?.artifacts) ? payload.artifacts : [])
    .filter((artifact) => artifact?.name === expected && artifact?.expired !== true && positiveInteger(artifact?.id));
  if (matches.length > 1) throw new HttpError(409, "扫描 artifact 无法唯一匹配", "artifact_ambiguous");
  return matches[0] || null;
}

export function limitStream(stream, maxBytes = MAX_ARTIFACT_BYTES) {
  let received = 0;
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const length = chunk?.byteLength;
      if (!Number.isSafeInteger(length) || length < 0) {
        controller.error(new Error("扫描 artifact 响应块无效"));
        return;
      }
      received += length;
      if (received > maxBytes) {
        controller.error(new Error("扫描 artifact 超出安全上限"));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

export async function downloadArtifact(env, run, requestId) {
  if (!run || run.status !== "completed" || run.conclusion !== "success") {
    throw new HttpError(409, "扫描尚未完成，artifact 不可用", "artifact_pending");
  }
  const artifact = await findArtifact(env, run, requestId);
  if (!artifact || !positiveInteger(artifact.id)) {
    throw new HttpError(409, "扫描结果 artifact 尚未发布", "artifact_pending");
  }
  const archive = await githubRawArtifact(env, artifact.id);
  if (!archive.body) throw new GitHubError(502, "GitHub artifact 响应为空");
  return secureResponse(
    new Response(limitStream(archive.body), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${ARTIFACT_PREFIX}-${requestId}.zip"`,
        "Cache-Control": "no-store",
      },
    }),
    { noStore: true },
  );
}
