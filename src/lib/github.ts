/**
 * GitHub Contents API로 Obsidian 볼트 저장소의 파일을 읽고 씁니다.
 *
 * 왜 GitHub? Obsidian은 내 PC의 폴더라서 클라우드(Vercel)에서 직접 접근할 수 없습니다.
 * Obsidian "Git" 플러그인으로 볼트를 GitHub에 자동 커밋/푸시해 두면,
 * 봇은 GitHub를 통해 볼트 파일을 읽고 쓸 수 있고, Obsidian은 다시 그것을 pull 합니다.
 */
import { config } from "./config.js";
import { ensureOk } from "./http.js";

const API = "https://api.github.com";

function headers() {
  return {
    Authorization: `Bearer ${config.obsidian.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export interface VaultFile { path: string; sha: string; content: string }

/** 파일 읽기. 없으면 null */
export async function readFile(path: string): Promise<VaultFile | null> {
  const res = await fetch(
    `${API}/repos/${config.obsidian.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(config.obsidian.branch)}`,
    { headers: headers() },
  );
  if (res.status === 404) return null;
  await ensureOk(res, `GitHub 읽기 ${path}`);
  const data = (await res.json()) as any;
  return { path, sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf8") };
}

/** 디렉터리 목록 (파일만). 없으면 빈 배열 */
export async function listDir(dir: string): Promise<Array<{ path: string; sha: string; name: string }>> {
  const res = await fetch(
    `${API}/repos/${config.obsidian.repo}/contents/${encodePath(dir)}?ref=${encodeURIComponent(config.obsidian.branch)}`,
    { headers: headers() },
  );
  if (res.status === 404) return [];
  await ensureOk(res, `GitHub 목록 ${dir}`);
  const data = (await res.json()) as any[];
  return data.filter((f) => f.type === "file").map((f) => ({ path: f.path, sha: f.sha, name: f.name }));
}

/** 파일 생성/덮어쓰기 (내용이 같으면 건너뜀). 반환: 변경 여부 */
export async function writeFile(path: string, content: string, message: string): Promise<boolean> {
  const existing = await readFile(path);
  if (existing && existing.content === content) return false;
  const res = await fetch(`${API}/repos/${config.obsidian.repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: config.obsidian.branch,
      ...(existing ? { sha: existing.sha } : {}),
      committer: { name: "jlaw-workhub bot", email: "bot@jlaw-workhub.local" },
    }),
  });
  await ensureOk(res, `GitHub 쓰기 ${path}`);
  return true;
}

export async function deleteFile(path: string, sha: string, message: string): Promise<void> {
  const res = await fetch(`${API}/repos/${config.obsidian.repo}/contents/${encodePath(path)}`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ message, sha, branch: config.obsidian.branch }),
  });
  await ensureOk(res, `GitHub 삭제 ${path}`);
}
