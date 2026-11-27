/**
 * 本地密码哈希（T-E01-09）：node:crypto scrypt + PHC 风格格式（无原生依赖）。
 *
 * 格式：scrypt$N$r$p$salt_b64$hash_b64。参数与 libsodium 兼容区间一致
 * （N=16384, r=8, p=1, keylen=64）；比对走 timingSafeEqual。
 * SSO 用户 password_hash 为 NULL，登录路径在哈希比对前即拒绝（见 auth 路由）。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;
// Node 默认 maxmem 32 MiB；N=16384,r=8 约需 16 MiB，显式放宽防边缘环境拒绝。
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/** 恒定时间校验；格式损坏/参数漂移一律返回 false（不抛错，调用方统一走 401）。 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
        return false;
    }
    const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
    if (
        nRaw === undefined ||
        rRaw === undefined ||
        pRaw === undefined ||
        saltRaw === undefined ||
        hashRaw === undefined
    ) {
        return false;
    }
    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    const salt = Buffer.from(saltRaw, "base64");
    const expected = Buffer.from(hashRaw, "base64");
    if (
        !Number.isInteger(n) ||
        !Number.isInteger(r) ||
        !Number.isInteger(p) ||
        n <= 0 ||
        r <= 0 ||
        p <= 0 ||
        salt.length === 0 ||
        expected.length === 0
    ) {
        return false;
    }
    try {
        const derived = await scrypt(password, salt, expected.length, {
            N: n,
            r,
            p,
            maxmem: MAXMEM,
        });
        return derived.length === expected.length && timingSafeEqual(derived, expected);
    } catch {
        return false;
    }
}
