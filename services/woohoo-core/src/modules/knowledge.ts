import type { Scope } from '@woohoo/contracts';

/**
 * Property knowledge — architecture doc §47, grounding and hallucination control.
 *
 * Property facts come ONLY from here. The prompt forbids answering from the model's own
 * knowledge, and results carry citations so that when a guest complains they were told the
 * wrong thing, you can show exactly what the system read.
 *
 * Retrieval is keyword-scored rather than vector-based: a property corpus is hundreds of
 * chunks, and a dedicated vector store is unjustified complexity at that size (§36). The
 * interface is shaped so pgvector slots in behind it unchanged.
 */

export interface KnowledgeChunk {
  id: string;
  propertyId: string;
  title: string;
  body: string;
  /** Shown to staff when auditing what the assistant said. */
  sourceRef: string;
  updatedAt: number;
}

export interface KnowledgeHit {
  chunkId: string;
  title: string;
  body: string;
  sourceRef: string;
  score: number;
}

export interface KnowledgeRepository {
  list(propertyId: string): Promise<KnowledgeChunk[]>;
  put(chunk: KnowledgeChunk): Promise<void>;
}

export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly rows = new Map<string, KnowledgeChunk>();
  async list(propertyId: string) {
    return [...this.rows.values()].filter((c) => c.propertyId === propertyId);
  }
  async put(chunk: KnowledgeChunk) {
    this.rows.set(chunk.id, chunk);
  }
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'do', 'does', 'i', 'my', 'me', 'what', 'when', 'where',
  'how', 'can', 'you', 'to', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'it', 'this', 'that',
]);

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export class KnowledgeService {
  constructor(private readonly repo: KnowledgeRepository) {}

  /**
   * Returns an empty array rather than a weak match when nothing scores. That is deliberate:
   * "I don't know, let me connect you to the front desk" is a supported and correct answer,
   * and a low-confidence guess about a hotel's amenities is exactly the failure mode §47 is
   * written to prevent.
   */
  async search(scope: Scope, query: string, limit = 3): Promise<KnowledgeHit[]> {
    const terms = tokenise(query);
    if (!terms.length) return [];
    const chunks = await this.repo.list(scope.propertyId);

    const scored = chunks.map((c) => {
      const hay = tokenise(`${c.title} ${c.body}`);
      const bag = new Set(hay);
      let score = 0;
      for (const t of terms) {
        if (bag.has(t)) score += 1;
        // Partial credit for stemming-ish matches ("checkout" vs "check-out" post-tokenisation).
        else if (hay.some((h) => h.startsWith(t) || t.startsWith(h))) score += 0.5;
      }
      return { c, score: score / terms.length };
    });

    return scored
      .filter((s) => s.score >= 0.34)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ c, score }) => ({
        chunkId: c.id,
        title: c.title,
        body: c.body,
        sourceRef: c.sourceRef,
        score: Math.round(score * 100) / 100,
      }));
  }
}
