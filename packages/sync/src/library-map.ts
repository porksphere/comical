/**
 * Shared mapping between `@comical/library`'s `ChapterProgress` and the sync `Progress` envelope.
 * Used by both the bootstrap bridge (library-bridge.ts) and the write-through wrapper
 * (library-writethrough.ts) so the two never drift.
 */
import type { ChapterProgress } from '@comical/library';
import { unpack } from './hlc.ts';
import type { Progress } from './crdt.ts';

export const toProgressFields = (p: ChapterProgress): Omit<Progress, 'kind' | 'hlc'> => ({
  read: p.read,
  lastPage: p.lastPage ?? 0,
  pageCount: p.pageCount ?? 0,
  number: p.number,
  languageCode: p.languageCode,
});

export const fromProgress = (chapterId: string, env: Progress): ChapterProgress => ({
  chapterId,
  read: env.read,
  lastPage: env.lastPage,
  pageCount: env.pageCount,
  number: env.number,
  languageCode: env.languageCode,
  updatedAt: unpack(env.hlc).physical,
});
