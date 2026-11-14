// Tree diffs and three-way merges over the forge's flat path maps. A merge is a conflict when
// the head and the base both changed the same path away from the merge-base and ended up with
// different bytes; anything else merges cleanly.

import { mergeBase, parseCommit } from './gitcore.ts';
import { forge, type Repo } from './store.ts';

export interface FileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  /** The file's bytes on the new side (null when removed). */
  readonly newData: Buffer | null;
  /** The file's bytes on the old side (null when added). */
  readonly oldData: Buffer | null;
}

function splitLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts for a changed file: lines added and removed, by multiset difference. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : splitLines(oldData);
  const newLines = newData === null ? [] : splitLines(newData);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
  for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
  if (additions === 0 && deletions === 0 && oldData !== null && newData !== null && !oldData.equals(newData)) {
    // A reorder-only change: the multisets match, so fall back to a positional comparison,
    // or a changed file would report zero additions and zero deletions.
    const max = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < max; i += 1) {
      if (oldLines[i] !== newLines[i]) {
        if (i < newLines.length) additions += 1;
        if (i < oldLines.length) deletions += 1;
      }
    }
  }
  return { additions, deletions };
}

/**
 * Diff two flat trees: every path added, removed or changed, with line counts. A file whose
 * bytes are identical on both sides is not a change.
 */
export function diffTrees(
  repo: Repo,
  oldFlat: Map<string, { oid: string; mode: string }>,
  newFlat: Map<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...oldFlat.keys(), ...newFlat.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldFlat.get(path);
    const newEntry = newFlat.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    const oldData = oldEntry === undefined ? null : (repo.objects.get(oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (repo.objects.get(newEntry.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    const status = oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified';
    changes.push({ filename: path, status, additions, deletions, changes: additions + deletions, newData, oldData });
  }
  return changes;
}

/** The flat tree of a commit, or an empty map when the commit is unknown. */
export function flatOf(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return new Map();
  return forge.flattenTree(repo, parseCommit(commit.data).tree);
}

export interface MergeOutcome {
  /** Null when the merge conflicts. */
  readonly mergedFlat: Map<string, { oid: string; mode: string }> | null;
  /** The paths that conflicted. */
  readonly conflicts: string[];
  /** The merge-base commit, when the histories meet. */
  readonly base: string | null;
}

/**
 * Three-way merge of head into base: start from the base tree, apply the head's changes relative
 * to the merge-base. A path changed on both sides to different bytes conflicts.
 */
export function threeWayMerge(repo: Repo, baseTip: string, headTip: string): MergeOutcome {
  const base = mergeBase(baseTip, headTip, (oid) => repo.objects.get(oid));
  const baseFlat = base === null ? new Map<string, { oid: string; mode: string }>() : flatOf(repo, base);
  const headFlat = flatOf(repo, headTip);
  const currentFlat = flatOf(repo, baseTip);
  const merged = new Map(currentFlat);
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const baseEntry = baseFlat.get(path);
    const headEntry = headFlat.get(path);
    const currentEntry = currentFlat.get(path);
    const headChanged = (baseEntry?.oid ?? null) !== (headEntry?.oid ?? null);
    const baseChanged = (baseEntry?.oid ?? null) !== (currentEntry?.oid ?? null);
    if (!headChanged) continue;
    if (!baseChanged) {
      if (headEntry === undefined) merged.delete(path);
      else merged.set(path, headEntry);
      continue;
    }
    if ((headEntry?.oid ?? null) === (currentEntry?.oid ?? null)) continue;
    conflicts.push(path);
  }
  if (conflicts.length > 0) return { mergedFlat: null, conflicts, base };
  return { mergedFlat: merged, conflicts, base };
}
