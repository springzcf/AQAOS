/**
 * 幂等响应存储（T-E01-08）。
 *
 * 一阶段为进程内 TTL 实现（单实例控制面）；接口与语义与 Redis 对齐，
 * M2 多副本部署时替换为 Redis 实现（含并发 in-flight 去重），调用方不变。
 */

export interface CachedResponse {
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
    readonly requestPayloadHash: string;
    expiresAt: number;
}

export interface IdempotencyStore {
    get(key: string): CachedResponse | undefined;
    set(key: string, entry: Omit<CachedResponse, "expiresAt">): void;
    readonly size: number;
}

export interface InMemoryIdempotencyStoreOptions {
    /** 缓存有效期（毫秒），默认 24 小时。 */
    readonly ttlMs?: number;
    /** 最大条目数（超限逐出最旧），默认 10000。 */
    readonly maxEntries?: number;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
    private readonly entries = new Map<string, CachedResponse>();
    private readonly ttlMs: number;
    private readonly maxEntries: number;

    constructor(options: InMemoryIdempotencyStoreOptions = {}) {
        this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
        this.maxEntries = options.maxEntries ?? 10_000;
    }

    get(key: string): CachedResponse | undefined {
        const entry = this.entries.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry;
    }

    set(key: string, entry: Omit<CachedResponse, "expiresAt">): void {
        this.sweepExpired();
        if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
            // Map 迭代序 = 插入序，首个键即最旧条目。
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) {
                this.entries.delete(oldest);
            }
        }
        this.entries.set(key, { ...entry, expiresAt: Date.now() + this.ttlMs });
    }

    get size(): number {
        return this.entries.size;
    }

    private sweepExpired(): void {
        const now = Date.now();
        for (const [key, entry] of this.entries) {
            if (entry.expiresAt <= now) {
                this.entries.delete(key);
            }
        }
    }
}
