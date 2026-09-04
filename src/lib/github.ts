/**
 * GitHub Contents API로 Obsidian 볼트 저장소의 파일을 읽고 씁니다.
 *
 * Obsidian은 내 PC의 폴더라서 클라우드(Vercel)가 직접 접근할 수 없습니다.
 * Obsidian "Git" 플러그인으로 볼트를 GitHub에 자동 커밋/푸시·풀 해 두면,
 * 봇은 GitHub를 통해 볼트 파일을 읽고 쓰고, Obsidian은 그것을 다시 내려받습니다.
 */
import { config } from "./config.js";
import { ensureOk } from "./http.js";

const API = "https://api.github.com";
const COMMITTER = { name: "jlaw-workhub bot", email: "bot@jlaw-workhub.local" };

function headers() {
  return {
    Authorization: `Bearer ${config.vault.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const ref = () => encodeURIComponent(config.vault.branch);

export interface VaultFile { path: string; sha: string; content: string }

/** 파일 읽기. 없으면 null */
export async function readFile(path: string): Promise<VaultFile | null> {
  const res = await fetch(`${API}/repos/${config.vault.repo}/contents/${enc(path)}?ref=${ref()}`, { headers: headers() });
  if (res.status === 404) return null;
  await ensureOk(res, `GitHub 읽기 ${path}`);
  const data = (await res.json()) as any;
  return { path, sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf8") };
}

/** 디렉터리의 파일 목록 (파일만). 없으면 빈 배열 */
export async function listDir(dir: string): Promise<Array<{ path: string; sha: string; name: string }>> {
  const res = await fetch(`${API}/repos/${config.vault.repo}/contents/${enc(dir)}?ref=${ref()}`, { headers: headers() });
  if (res.status === 404) return [];
  await ensureOk(res, `GitHub 목록 ${dir}`);
  const data = (await res.json()) as any[];
  return data.filter((f) => f.type === "file").map((f) => ({ path: f.path, sha: f.sha, name: f.name }));
}

/** 디렉터리 안의 .md 파일을 모두 읽습니다 (병렬) */
export async function readDirMarkdown(dir: string): Promise<VaultFile[]> {
  const files = (await listDir(dir)).filter((f) => f.name.endsWith(".md"));
  const out = await Promise.all(files.map((f) => readFile(f.path)));
  return out.filter((f): f is VaultFile => Boolean(f));
}

/** 파일 생성/덮어쓰기. 내용이 같으면 건너뜁니다. 반환: 변경 여부 */
export async function writeFile(path: string, content: string, message: string, knownSha?: string): Promise<boolean> {
  let sha = knownSha;
  if (!sha) {
    const existing = await readFile(path);
    if (existing && existing.content === content) return false;
    sha = existing?.sha;
  }
  const res = await fetch(`${API}/repos/${config.vault.repo}/contents/${enc(path)}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      message, branch: config.vault.branch, committer: COMMITTER,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  await ensureOk(res, `GitHub 쓰기 ${path}`);
  return true;
}

export async function deleteFile(path: string, sha: string, message: string): Promise<void> {
  const res = await fetch(`${API}/repos/${config.vault.repo}/contents/${enc(path)}`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ message, sha, branch: config.vault.branch, committer: COMMITTER }),
  });
  await ensureOk(res, `GitHub 삭제 ${path}`);
}

/** 파일 이동 = 새 위치에 쓰고 옛 파일 삭제 */
export async function moveFile(from: VaultFile, to: string, content: string, message: string): Promise<void> {
  await writeFile(to, content, message);
  await deleteFile(from.path, from.sha, message);
}
