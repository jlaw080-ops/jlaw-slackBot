/**
 * GitHub API로 Obsidian 볼트 저장소의 파일을 읽고 씁니다.
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
export interface TreeEntry { path: string; sha: string; type: "blob" | "tree"; size?: number }

/** 파일 읽기. 없으면 null */
export async function readFile(path: string): Promise<VaultFile | null> {
  const res = await fetch(`${API}/repos/${config.vault.repo}/contents/${enc(path)}?ref=${ref()}`, { headers: headers() });
  if (res.status === 404) return null;
  await ensureOk(res, `GitHub 읽기 ${path}`);
  const data = (await res.json()) as any;
  if (Array.isArray(data)) return null; // 디렉터리
  return { path, sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf8") };
}

/**
 * blob SHA로 내용 읽기 (트리 스캔 후 병렬 읽기용).
 * 같은 SHA의 내용은 영원히 바뀌지 않으므로 캐시해도 안전합니다.
 * 한 번의 호출 안에서 같은 노트를 여러 번 읽는 경로(브리핑·중복검사)가 겹쳐도 API를 한 번만 씁니다.
 */
const blobCache = new Map<string, string>();
const BLOB_CACHE_MAX = 800;

export async function readBlob(path: string, sha: string): Promise<VaultFile> {
  const hit = blobCache.get(sha);
  if (hit !== undefined) return { path, sha, content: hit };
  const res = await fetch(`${API}/repos/${config.vault.repo}/git/blobs/${sha}`, { headers: headers() });
  await ensureOk(res, `GitHub blob ${path}`);
  const data = (await res.json()) as any;
  const content = Buffer.from(data.content, "base64").toString("utf8");
  if (blobCache.size >= BLOB_CACHE_MAX) blobCache.clear();
  blobCache.set(sha, content);
  return { path, sha, content };
}

/** 저장소 전체 트리를 재귀로 한 번에 가져와(경로·SHA만) 하위 경로로 거릅니다 */
let treeCache: { at: number; entries: TreeEntry[] } | null = null;
export async function listTree(subdir?: string): Promise<TreeEntry[]> {
  if (!treeCache || Date.now() - treeCache.at > 15_000) {
    const res = await fetch(`${API}/repos/${config.vault.repo}/git/trees/${ref()}?recursive=1`, { headers: headers() });
    if (res.status === 404) return [];
    await ensureOk(res, "GitHub 트리");
    const data = (await res.json()) as any;
    if (data.truncated) console.warn("GitHub 트리가 잘렸습니다(파일이 너무 많음). 일부 노트를 놓칠 수 있습니다.");
    treeCache = { at: Date.now(), entries: (data.tree ?? []).map((t: any) => ({ path: t.path, sha: t.sha, type: t.type, size: t.size })) };
  }
  const prefix = subdir ? `${subdir.replace(/\/$/, "")}/` : "";
  return treeCache.entries.filter((t) => t.path.startsWith(prefix));
}
export function invalidateTreeCache() { treeCache = null; }

/** 여러 파일을 병렬로 읽습니다 (동시 16개) */
export async function readMany(entries: Array<{ path: string; sha: string }>): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  for (let i = 0; i < entries.length; i += 16) {
    const chunk = entries.slice(i, i + 16);
    const got = await Promise.all(chunk.map((e) => readBlob(e.path, e.sha).catch(() => null)));
    for (const f of got) if (f) out.push(f);
  }
  return out;
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
  invalidateTreeCache();
  return true;
}
