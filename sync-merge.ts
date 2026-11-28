/* ============================================================
 * 双端同步的纯数据逻辑。
 * 不依赖 Obsidian API，可独立编译成 Node 脚本做单元测试。
 * ============================================================ */

/** 一个时间块。start / end 为距 0:00 的分钟数 */
export interface Timeblock {
  start: number;
  end: number;
  title: string;
  category: string;
  goal: string;
  note: string;
  done: boolean;
}

/** 目标拆解出的一小步 */
export interface GoalStep {
  text: string;
  done: boolean;
}

/** 一个目标 */
export interface Goal {
  name: string;
  targetHours: number;
  due: string;
  status: string;
  steps: GoalStep[];
}

/** 云端 / 本地共用的同步载荷 */
export interface SyncPayload {
  days: Record<string, Timeblock[]>;
  dayTs: Record<string, number>;
  goals: Goal[];
  goalsTs: number;
}

/** Gist 里的快照文件 */
export interface CloudSnapshot extends SyncPayload {
  schema: 1;
  updatedAt: number;
  deviceId: string;
}

export interface MergeReport {
  merged: SyncPayload;
  /** 从云端拉取覆盖本地的日期 */
  pulledDays: string[];
  /** 本地较新、需要推送到云端的日期 */
  pushedDays: string[];
  /** 上次同步后两端都改过同一天：以较新者为准，需提示用户 */
  conflictDays: string[];
  goalsFromCloud: boolean;
  goalsConflict: boolean;
  /** merged 与云端内容不同，需要 PATCH */
  changed: boolean;
}

export function blocksEqual(a: Timeblock[] | undefined, b: Timeblock[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export function goalsEqual(a: Goal[] | undefined, b: Goal[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** 判断两个载荷内容是否一致（时间戳不参与比较，只看实际数据） */
export function payloadEqual(a: SyncPayload, b: SyncPayload): boolean {
  const ak = Object.keys(a.days).sort();
  const bk = Object.keys(b.days).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (!blocksEqual(a.days[ak[i]], b.days[bk[i]])) return false;
  }
  return goalsEqual(a.goals, b.goals);
}

/**
 * 按「天」和「目标库」两个粒度做双向合并：
 * - 两端改了不同日期 → 各自保留，无损合并
 * - 只有一端改过 → 取改过的那端
 * - 同一天两端都改 → 取时间戳较新者（LWW），并记为冲突提示用户
 * lastSyncAt 用来区分「上次同步后本地是否有未推送的改动」。
 */
export function mergeSyncPayloads(
  local: SyncPayload,
  cloud: SyncPayload,
  lastSyncAt: number
): MergeReport {
  const merged: SyncPayload = { days: {}, dayTs: {}, goals: [], goalsTs: 0 };
  const pulledDays: string[] = [];
  const pushedDays: string[] = [];
  const conflictDays: string[] = [];

  const keys = new Set<string>([...Object.keys(local.days), ...Object.keys(cloud.days)]);
  for (const k of keys) {
    const lt = local.dayTs[k] ?? 0;
    const ct = cloud.dayTs[k] ?? 0;
    const lb = local.days[k];
    const cb = cloud.days[k];
    const localChanged = lt > lastSyncAt;
    const cloudChanged = ct > lastSyncAt;
    const same = blocksEqual(lb, cb);
    // 上次同步后两端都改过同一天且结果不同 → 记为冲突（无论哪端获胜）
    if (localChanged && cloudChanged && !same) conflictDays.push(k);

    if (ct > lt && cb !== undefined) {
      merged.days[k] = cb;
      merged.dayTs[k] = ct;
      pulledDays.push(k);
    } else {
      merged.days[k] = lb ?? cb ?? [];
      merged.dayTs[k] = lt > 0 ? lt : ct;
      if (!same || ct !== lt) pushedDays.push(k);
    }
  }

  const lgt = local.goalsTs;
  const cgt = cloud.goalsTs;
  const goalsSame = goalsEqual(local.goals, cloud.goals);
  const goalsBothChanged = lgt > lastSyncAt && cgt > lastSyncAt && !goalsSame;
  let goalsFromCloud = false;
  if (cgt > lgt) {
    merged.goals = cloud.goals ?? [];
    merged.goalsTs = cgt;
    goalsFromCloud = true;
  } else {
    merged.goals = local.goals ?? [];
    merged.goalsTs = lgt > 0 ? lgt : cgt;
  }

  return {
    merged,
    pulledDays,
    pushedDays,
    conflictDays,
    goalsFromCloud,
    goalsConflict: goalsBothChanged,
    changed: !payloadEqual(merged, cloud),
  };
}

/** 简单内容哈希，用于兜底检测外部文件变更 */
export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h);
}
