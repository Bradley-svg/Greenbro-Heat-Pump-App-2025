import type { Env } from '../types/env';

export async function audit(
  env: Env,
  actor: { sub: string; roles: string[] },
  action: string,
  target: string,
  meta?: unknown
) {
  try {
    await env.DB.prepare(
      `INSERT INTO writes_audit (id, ts, actor_sub, actor_roles, action, target, meta_json)
       VALUES (?,?,?,?,?,?,?)`
    )
      .bind(
        crypto.randomUUID(),
        new Date().toISOString(),
        actor.sub,
        JSON.stringify(actor.roles ?? []),
        action,
        target,
        meta ? JSON.stringify(meta) : null
      )
      .run();
  } catch {
    // swallow in case older schema name differs
  }
}
